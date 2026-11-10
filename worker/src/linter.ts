/**
 * Linter agent (task 4.5): scheduled drift detection. Deterministic checks
 * (sync drift, stale events, milestone risk, orphans, unresolved
 * contradictions) run free; the narrative-drift check compares each current
 * narrative against tracked-work state via the mid-tier model.
 *
 * Findings are upserted on a stable dedupe key, so daily re-runs refresh
 * `last_seen_at` instead of duplicating. Deterministic findings whose
 * condition has cleared are auto-resolved; narrative-drift findings resolve
 * when the narrative moves to a new revision.
 */
import type { ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";
import { and, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { tables } from "@second-brain/schema";
import { changeImpact, designGaps, detectDependencies } from "./analyst.ts";
import type { WorkerDeps } from "./lib/deps.ts";
import { emitMetric } from "./lib/metrics.ts";

const STALE_BLOCKER_DAYS = Number(process.env.LINT_STALE_BLOCKER_DAYS ?? 14);
const STALE_DEADLINE_DAYS = Number(process.env.LINT_STALE_DEADLINE_DAYS ?? 30);
const CONTRADICTION_DAYS = Number(process.env.LINT_CONTRADICTION_DAYS ?? 7);
const MILESTONE_HORIZON_DAYS = Number(process.env.LINT_MILESTONE_HORIZON_DAYS ?? 7);

export interface Finding {
  kind: (typeof tables.lintFindings.$inferInsert)["kind"];
  dedupeKey: string;
  summary: string;
  projectId?: string | null;
  detail?: string;
  refs?: Record<string, unknown>;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

// --- Deterministic detectors ---

/** Active blocker/deadline claims that have sat unrefreshed past their horizon. */
async function staleEvents(deps: WorkerDeps): Promise<Finding[]> {
  const rows = await deps.db
    .select({
      id: tables.events.id,
      type: tables.events.type,
      title: tables.events.title,
      at: tables.events.extractedAt,
      projectId: tables.eventProjects.projectId,
    })
    .from(tables.events)
    .innerJoin(tables.eventProjects, eq(tables.eventProjects.eventId, tables.events.id))
    .where(
      and(
        eq(tables.events.status, "active"),
        sql`(
          (${tables.events.type} = 'blocker_raised' and ${tables.events.extractedAt} < ${daysAgo(STALE_BLOCKER_DAYS).toISOString()})
          or (${tables.events.type} in ('deadline_set', 'deadline_slipped') and ${tables.events.extractedAt} < ${daysAgo(STALE_DEADLINE_DAYS).toISOString()})
        )`,
      ),
    );
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    if (seen.has(r.id)) return [];
    seen.add(r.id);
    const days = r.type === "blocker_raised" ? STALE_BLOCKER_DAYS : STALE_DEADLINE_DAYS;
    return [
      {
        kind: "stale_event" as const,
        dedupeKey: `stale_event:${r.id}`,
        projectId: r.projectId,
        summary: `${r.type.replace(/_/g, " ")} unrefreshed for over ${days} days: ${r.title}`,
        detail:
          r.type === "blocker_raised"
            ? "Still active with no blocker_resolved event since. Resolve it or reject the claim."
            : "No newer deadline event supersedes this claim; the date may have passed or moved.",
        refs: { eventIds: [r.id] },
      },
    ];
  });
}

/** GitLab issues whose synced Jira counterpart disagrees on open/closed. */
async function syncDrift(deps: WorkerDeps): Promise<Finding[]> {
  const links = await deps.db.select().from(tables.jiraSyncLinks);
  if (links.length === 0) return [];

  const gitlabItems = await deps.db
    .select()
    .from(tables.workItems)
    .where(
      and(
        eq(tables.workItems.source, "gitlab"),
        eq(tables.workItems.kind, "issue"),
        inArray(tables.workItems.sourceId, links.map((l) => String(l.gitlabIssueId))),
      ),
    );
  const jiraItems = await deps.db
    .select()
    .from(tables.workItems)
    .where(
      and(
        eq(tables.workItems.source, "jira"),
        inArray(tables.workItems.sourceId, links.map((l) => l.jiraKey)),
      ),
    );
  const gitlabById = new Map(gitlabItems.map((w) => [w.sourceId, w]));
  const jiraByKey = new Map(jiraItems.map((w) => [w.sourceId, w]));

  const findings: Finding[] = [];
  for (const link of links) {
    const gl = gitlabById.get(String(link.gitlabIssueId));
    const jr = jiraByKey.get(link.jiraKey);
    if (!gl || !jr) continue; // mirror lag, not drift
    const glClosed = gl.state === "closed";
    const jrDone = jr.state === "done";
    if (glClosed !== jrDone) {
      findings.push({
        kind: "sync_drift",
        dedupeKey: `sync_drift:${link.jiraKey}`,
        projectId: gl.projectId ?? jr.projectId,
        summary: `${link.jiraKey} is ${jrDone ? "done" : "not done"} in Jira but its GitLab issue is ${gl.state}`,
        detail: `GitLab: ${link.gitlabIssueUrl} (${gl.state}) · Jira: ${jr.webUrl} (${jr.state}). The one-way sync only creates/updates content — status is reconciled by humans.`,
        refs: { jiraKey: link.jiraKey, gitlabIssueUrl: link.gitlabIssueUrl, workItemIds: [gl.id, jr.id] },
      });
    }
  }
  return findings;
}

/** Milestones due within the horizon (or past due) with no recent work-item activity. */
async function milestoneRisk(deps: WorkerDeps): Promise<Finding[]> {
  const horizon = new Date(Date.now() + MILESTONE_HORIZON_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const milestones = await deps.db
    .select()
    .from(tables.milestones)
    .where(and(eq(tables.milestones.state, "active"), sql`${tables.milestones.dueDate} <= ${horizon}`));

  const findings: Finding[] = [];
  for (const m of milestones) {
    // No project/repo linkage → no activity signal to compare against; the
    // orphan detector covers unlinked entities.
    const scope = m.projectId
      ? eq(tables.workItems.projectId, m.projectId)
      : m.repoId
        ? eq(tables.workItems.repoId, m.repoId)
        : null;
    if (!scope) continue;
    const [recent] = await deps.db
      .select({ id: tables.workItems.id })
      .from(tables.workItems)
      .where(and(scope, sql`${tables.workItems.sourceUpdatedAt} > ${daysAgo(7).toISOString()}`))
      .limit(1);
    if (recent) continue;
    const overdue = m.dueDate && m.dueDate < new Date().toISOString().slice(0, 10);
    findings.push({
      kind: "milestone_risk",
      dedupeKey: `milestone_risk:${m.id}`,
      projectId: m.projectId,
      summary: `Milestone "${m.title}" is ${overdue ? "past due" : `due by ${m.dueDate}`} with no work-item activity in 7 days`,
      detail: m.webUrl ?? undefined,
      refs: { milestoneId: m.id },
    });
  }
  return findings;
}

/** Entities missing the links the rest of the system assumes. */
async function orphans(deps: WorkerDeps): Promise<Finding[]> {
  const findings: Finding[] = [];

  const pocless = await deps.db
    .select({ id: tables.projects.id, name: tables.projects.name })
    .from(tables.projects)
    .where(and(isNull(tables.projects.pocId), sql`${tables.projects.gitlabGroupId} is not null`));
  for (const p of pocless) {
    findings.push({
      kind: "orphan",
      dedupeKey: `orphan:project-poc:${p.id}`,
      projectId: p.id,
      summary: `Project "${p.name}" has no POC assigned`,
      detail: "Rejects and untracked-work conversion for this project fall to L1s only.",
    });
  }

  // Unlinked work items grouped per source project — one finding, not hundreds.
  const unlinked = await deps.db
    .select({
      sourceProject: tables.workItems.sourceProject,
      n: sql<number>`count(*)::int`,
    })
    .from(tables.workItems)
    .where(and(isNull(tables.workItems.projectId), isNull(tables.workItems.repoId)))
    .groupBy(tables.workItems.sourceProject);
  for (const u of unlinked) {
    findings.push({
      kind: "orphan",
      dedupeKey: `orphan:unlinked-work:${u.sourceProject ?? "unknown"}`,
      summary: `${u.n} work item(s) in "${u.sourceProject ?? "unknown"}" link to no brain project or repo`,
      detail: "Extend the sync mapping or seed the project so events can attach to them.",
      refs: { sourceProject: u.sourceProject, count: u.n },
    });
  }
  return findings;
}

/** Open contradictions that have sat unresolved past the attention window. */
async function unresolvedContradictions(deps: WorkerDeps): Promise<Finding[]> {
  const rows = await deps.db
    .select()
    .from(tables.contradictions)
    .where(
      and(
        eq(tables.contradictions.status, "open"),
        lt(tables.contradictions.createdAt, daysAgo(CONTRADICTION_DAYS)),
      ),
    );
  return rows.map((c) => ({
    kind: "unresolved_contradiction" as const,
    dedupeKey: `unresolved_contradiction:${c.id}`,
    projectId: c.projectId,
    summary: `Contradiction open for over ${CONTRADICTION_DAYS} days: ${c.summary}`,
    detail: c.resolution ? `Brain's provisional read: ${c.resolution}` : undefined,
    refs: { contradictionId: c.id, eventIds: [c.eventAId, c.eventBId] },
  }));
}

// --- LLM narrative-drift check ---

const driftSchema = z.object({
  findings: z
    .array(
      z.object({
        summary: z.string().min(10).max(300),
        detail: z.string().max(1000).optional(),
        work_item_references: z.array(z.string()).default([]),
      }),
    )
    .max(5),
});

const DRIFT_TOOL: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "emit_findings",
        description: "Emit narrative-vs-tracked-work drift findings.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              findings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    summary: { type: "string", description: "One line: what the narrative claims vs what the tracker shows." },
                    detail: { type: "string", description: "Supporting specifics, optional." },
                    work_item_references: {
                      type: "array",
                      items: { type: "string" },
                      description: "References (INFRA-12, !45) of the work items contradicting the claim.",
                    },
                  },
                  required: ["summary"],
                },
              },
            },
            required: ["findings"],
          },
        },
      },
    },
  ],
  toolChoice: { tool: { name: "emit_findings" } },
};

const DRIFT_SYSTEM = `You are a consistency linter for an engineering org's knowledge base. You receive a project's status narrative (LLM-written from extracted events) and the current state of its tracked work items (Jira issues, GitLab MRs).

Report ONLY concrete factual drift: the narrative asserts something the tracker contradicts (work described as shipped while its MR is open, a deadline stated as holding while the issue is untouched, a blocker described as active while the blocking issue is done). Do not report stylistic issues, missing detail, or tracker items the narrative simply doesn't mention. No drift → empty findings array.`;

async function narrativeDrift(deps: WorkerDeps): Promise<{ findings: Finding[]; checked: number }> {
  if (!deps.llm) {
    deps.logger.warn("llm unavailable; skipping narrative-drift check");
    return { findings: [], checked: 0 };
  }

  const narratives = await deps.db
    .select({
      projectId: tables.narratives.projectId,
      revisionId: tables.narratives.currentRevisionId,
      body: tables.narrativeRevisions.body,
      projectName: tables.projects.name,
    })
    .from(tables.narratives)
    .innerJoin(
      tables.narrativeRevisions,
      eq(tables.narrativeRevisions.id, tables.narratives.currentRevisionId),
    )
    .innerJoin(tables.projects, eq(tables.projects.id, tables.narratives.projectId))
    .where(eq(tables.narratives.kind, "status"));

  const findings: Finding[] = [];
  let checked = 0;
  for (const n of narratives) {
    const items = await deps.db
      .select()
      .from(tables.workItems)
      .where(eq(tables.workItems.projectId, n.projectId))
      .orderBy(sql`${tables.workItems.sourceUpdatedAt} desc nulls last`)
      .limit(40);
    if (items.length === 0) continue;

    const itemLines = items
      .map(
        (w) =>
          `- ${w.reference ?? w.sourceId} [${w.source} ${w.kind}] "${w.title}" — state: ${w.state}, updated: ${w.sourceUpdatedAt?.toISOString().slice(0, 10) ?? "unknown"}`,
      )
      .join("\n");

    const response = await deps.llm.invoke("linter", {
      system: DRIFT_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              text: `Project: ${n.projectName}\n\n== Status narrative ==\n${n.body.slice(0, 12_000)}\n\n== Tracked work items ==\n${itemLines}`,
            },
          ],
        },
      ],
      toolConfig: DRIFT_TOOL,
      purpose: `lint:narrative-drift:${n.projectId}`,
    });
    checked++;

    const toolUse = response.message?.content?.find((c) => c.toolUse)?.toolUse;
    const parsed = driftSchema.safeParse(toolUse?.input);
    if (!parsed.success) {
      // Advisory check: log and move on rather than retry-loop a whole project scan.
      deps.logger.warn({ projectId: n.projectId }, "drift output failed validation; skipping project");
      continue;
    }
    for (const f of parsed.data.findings) {
      // Key on the revision: a re-synthesized narrative retires old drift findings.
      const digest = f.summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
      findings.push({
        kind: "narrative_drift",
        dedupeKey: `narrative_drift:${n.revisionId}:${digest}`,
        projectId: n.projectId,
        summary: f.summary,
        detail: f.detail,
        refs: { revisionId: n.revisionId, workItemReferences: f.work_item_references },
      });
    }
  }
  return { findings, checked };
}

// --- Reconciliation ---

// change_impact rides along: it is fully re-derived from open dependencies +
// active events each pass, so the not-detected-anymore sweep applies.
// design_gap does NOT: docs are analyzed once, so absence from a later pass
// means "not re-checked", not "fixed" — those retire per file revision or by
// human dismissal.
const DETERMINISTIC_KINDS = [
  "sync_drift",
  "stale_event",
  "milestone_risk",
  "orphan",
  "unresolved_contradiction",
  "change_impact",
] as const;

async function reconcile(
  deps: WorkerDeps,
  detected: Finding[],
  driftChecked: boolean,
): Promise<{ upserted: number; resolved: number }> {
  const now = new Date();
  for (const f of detected) {
    await deps.db
      .insert(tables.lintFindings)
      .values({
        kind: f.kind,
        projectId: f.projectId ?? null,
        summary: f.summary,
        detail: f.detail,
        refs: f.refs ?? {},
        dedupeKey: f.dedupeKey,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: tables.lintFindings.dedupeKey,
        set: {
          summary: f.summary,
          detail: f.detail,
          refs: f.refs ?? {},
          lastSeenAt: now,
          // Reappearing conditions reopen; human "dismissed" stays dismissed.
          status: sql`case when ${tables.lintFindings.status} = 'resolved' then 'open'::lint_finding_status else ${tables.lintFindings.status} end`,
          resolvedAt: sql`case when ${tables.lintFindings.status} = 'resolved' then null else ${tables.lintFindings.resolvedAt} end`,
        },
      });
  }

  // Auto-resolve deterministic findings whose condition cleared this run.
  const detectedKeys = detected.map((f) => f.dedupeKey);
  const staleOpen = await deps.db
    .update(tables.lintFindings)
    .set({ status: "resolved", resolvedAt: now })
    .where(
      and(
        eq(tables.lintFindings.status, "open"),
        inArray(tables.lintFindings.kind, [...DETERMINISTIC_KINDS]),
        detectedKeys.length > 0
          ? notInArray(tables.lintFindings.dedupeKey, detectedKeys)
          : undefined,
      ),
    )
    .returning({ id: tables.lintFindings.id });

  // Narrative-drift findings from superseded revisions retire once the check
  // has actually re-run (an LLM outage must not silently resolve findings).
  let driftResolved = 0;
  if (driftChecked) {
    const currentRevisions = await deps.db
      .select({ id: tables.narratives.currentRevisionId })
      .from(tables.narratives)
      .where(sql`${tables.narratives.currentRevisionId} is not null`);
    const revisionIds = currentRevisions.map((r) => r.id).filter((x): x is string => Boolean(x));
    const rows = await deps.db
      .update(tables.lintFindings)
      .set({ status: "resolved", resolvedAt: now })
      .where(
        and(
          eq(tables.lintFindings.status, "open"),
          eq(tables.lintFindings.kind, "narrative_drift"),
          detectedKeys.length > 0
            ? notInArray(tables.lintFindings.dedupeKey, detectedKeys)
            : undefined,
          revisionIds.length > 0
            ? sql`${tables.lintFindings.refs}->>'revisionId' not in (${sql.join(
                revisionIds.map((id) => sql`${id}`),
                sql`, `,
              )})`
            : undefined,
        ),
      )
      .returning({ id: tables.lintFindings.id });
    driftResolved = rows.length;
  }

  return { upserted: detected.length, resolved: staleOpen.length + driftResolved };
}

/** Full lint pass: all detectors, then reconcile against stored findings. */
export async function lintAll(deps: WorkerDeps): Promise<{
  detected: number;
  resolved: number;
  byKind: Record<string, number>;
  driftChecked: number;
  dependencies: { detected: number; resolved: number };
  gapDocsAnalyzed: number;
}> {
  // Dependencies first so the change-impact check sees records from this pass.
  const dependencyResult = await detectDependencies(deps);

  const [stale, drift, milestones, orphaned, contradictions, impacts] = await Promise.all([
    staleEvents(deps),
    syncDrift(deps),
    milestoneRisk(deps),
    orphans(deps),
    unresolvedContradictions(deps),
    changeImpact(deps),
  ]);
  const narrative = await narrativeDrift(deps);
  const gaps = await designGaps(deps);

  const detected = [
    ...stale,
    ...drift,
    ...milestones,
    ...orphaned,
    ...contradictions,
    ...impacts,
    ...narrative.findings,
    ...gaps.findings,
  ];
  const { resolved } = await reconcile(deps, detected, narrative.checked > 0);

  const byKind: Record<string, number> = {};
  for (const f of detected) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

  emitMetric("lint_findings_open", detected.length, { stage: "lint" });
  return {
    detected: detected.length,
    resolved,
    byKind,
    driftChecked: narrative.checked,
    dependencies: dependencyResult,
    gapDocsAnalyzed: gaps.docsAnalyzed,
  };
}

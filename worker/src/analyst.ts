/**
 * Dependency / conflict / gap / change-impact analysis (task 4.6, brain-agents
 * spec). Runs inside the daily lint pass and shares its budget (linter agent):
 *
 * - Dependency detection (LLM): events citing 2+ projects are candidates; the
 *   model decides which express a real cross-project dependency and its
 *   direction. Records land in `dependencies`, visible on both projects.
 * - Change impact (deterministic): an open dependency whose prerequisite
 *   project has an active slipped-deadline or blocker event files a
 *   change_impact finding on the dependent project, citing the cause.
 * - Design gap (LLM): new watched-drive design docs are classified and their
 *   scope compared against the project's tracked work items; uncovered scope
 *   becomes design_gap findings linking the doc to the missing coverage.
 */
import type { ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import { tables } from "@second-brain/schema";
import type { WorkerDeps } from "./lib/deps.ts";
import type { Finding } from "./linter.ts";
import { getRawArtifact } from "./raw.ts";

const GAP_DOCS_PER_PASS = Number(process.env.LINT_GAP_DOCS_PER_PASS ?? 3);
const DEPENDENCY_CANDIDATES = Number(process.env.LINT_DEPENDENCY_CANDIDATES ?? 50);

// --- Dependency detection (LLM) ---

const dependencySchema = z.object({
  dependencies: z
    .array(
      z.object({
        dependent_slug: z.string(),
        prerequisite_slug: z.string(),
        summary: z.string().min(10).max(300),
        event_ids: z.array(z.string().uuid()).min(1),
      }),
    )
    .max(20),
});

const DEPENDENCY_TOOL: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "emit_dependencies",
        description: "Emit cross-project dependencies expressed in the events.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              dependencies: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    dependent_slug: {
                      type: "string",
                      description: "slug of the project whose work is waiting",
                    },
                    prerequisite_slug: {
                      type: "string",
                      description: "slug of the project being waited on",
                    },
                    summary: {
                      type: "string",
                      description: "One line: what depends on what, and why.",
                    },
                    event_ids: {
                      type: "array",
                      items: { type: "string" },
                      description: "ids of the events expressing this dependency",
                    },
                  },
                  required: ["dependent_slug", "prerequisite_slug", "summary", "event_ids"],
                },
              },
            },
            required: ["dependencies"],
          },
        },
      },
    },
  ],
  toolChoice: { tool: { name: "emit_dependencies" } },
};

const DEPENDENCY_SYSTEM = `You identify cross-project dependencies for an engineering org's knowledge base. You receive events that were each linked to two or more projects, with the linked project slugs.

Emit a dependency ONLY when the event text expresses that one project's work waits on another's (blocked on, needs, waiting for, can't ship until). An event merely mentioning two projects together (a shared meeting, a joint announcement) is NOT a dependency. Direction matters: dependent = the waiting side, prerequisite = the side being waited on. Use only the provided event ids and project slugs. Nothing qualifying → empty array.`;

/** Active events linked to 2+ projects, with their slugs — dependency candidates. */
async function dependencyCandidates(deps: WorkerDeps) {
  const multi = await deps.db
    .select({
      eventId: tables.eventProjects.eventId,
      n: sql<number>`count(*)::int`,
    })
    .from(tables.eventProjects)
    .innerJoin(tables.events, eq(tables.events.id, tables.eventProjects.eventId))
    .where(eq(tables.events.status, "active"))
    .groupBy(tables.eventProjects.eventId)
    .having(sql`count(*) >= 2`)
    .limit(DEPENDENCY_CANDIDATES);
  if (multi.length === 0) return [];

  const ids = multi.map((m) => m.eventId);
  const rows = await deps.db
    .select({
      id: tables.events.id,
      type: tables.events.type,
      title: tables.events.title,
      body: tables.events.body,
      slug: tables.projects.slug,
    })
    .from(tables.events)
    .innerJoin(tables.eventProjects, eq(tables.eventProjects.eventId, tables.events.id))
    .innerJoin(tables.projects, eq(tables.projects.id, tables.eventProjects.projectId))
    .where(inArray(tables.events.id, ids))
    .orderBy(desc(tables.events.extractedAt));

  const byEvent = new Map<
    string,
    { id: string; type: string; title: string; body: string | null; slugs: string[] }
  >();
  for (const r of rows) {
    const e = byEvent.get(r.id) ?? { id: r.id, type: r.type, title: r.title, body: r.body, slugs: [] };
    e.slugs.push(r.slug);
    byEvent.set(r.id, e);
  }
  return [...byEvent.values()];
}

export async function detectDependencies(
  deps: WorkerDeps,
): Promise<{ detected: number; resolved: number }> {
  const now = new Date();
  let detected = 0;

  if (deps.llm) {
    const candidates = await dependencyCandidates(deps);
    if (candidates.length > 0) {
      const projectRows = await deps.db
        .select({ id: tables.projects.id, slug: tables.projects.slug })
        .from(tables.projects);
      const idBySlug = new Map(projectRows.map((p) => [p.slug, p.id]));

      const eventLines = candidates
        .map(
          (e) =>
            `- event ${e.id} [${e.type}] (projects: ${e.slugs.join(", ")}): ${e.title}${e.body ? ` — ${e.body.slice(0, 300)}` : ""}`,
        )
        .join("\n");

      const response = await deps.llm.invoke("linter", {
        system: DEPENDENCY_SYSTEM,
        messages: [{ role: "user", content: [{ text: `Candidate events:\n${eventLines}` }] }],
        toolConfig: DEPENDENCY_TOOL,
        purpose: "lint:dependencies",
      });
      const toolUse = response.message?.content?.find((c) => c.toolUse)?.toolUse;
      const parsed = dependencySchema.safeParse(toolUse?.input);
      if (!parsed.success) {
        deps.logger.warn("dependency output failed validation; skipping this pass");
      } else {
        const candidateIds = new Set(candidates.map((c) => c.id));
        for (const d of parsed.data.dependencies) {
          const dependentId = idBySlug.get(d.dependent_slug);
          const prerequisiteId = idBySlug.get(d.prerequisite_slug);
          const eventIds = d.event_ids.filter((id) => candidateIds.has(id));
          // Hallucinated slugs/ids or self-dependencies are dropped, not stored.
          if (!dependentId || !prerequisiteId || dependentId === prerequisiteId) continue;
          if (eventIds.length === 0) continue;
          detected++;
          await deps.db
            .insert(tables.dependencies)
            .values({
              dependentProjectId: dependentId,
              prerequisiteProjectId: prerequisiteId,
              summary: d.summary,
              refs: { eventIds },
              dedupeKey: `dependency:${dependentId}:${prerequisiteId}:${eventIds[0]}`,
              lastSeenAt: now,
            })
            .onConflictDoUpdate({
              target: tables.dependencies.dedupeKey,
              set: {
                summary: d.summary,
                refs: { eventIds },
                lastSeenAt: now,
                status: sql`case when ${tables.dependencies.status} = 'resolved' then 'open'::dependency_status else ${tables.dependencies.status} end`,
                resolvedAt: sql`case when ${tables.dependencies.status} = 'resolved' then null else ${tables.dependencies.resolvedAt} end`,
              },
            });
        }
      }
    }
  } else {
    deps.logger.warn("llm unavailable; skipping dependency detection");
  }

  // Deterministic retirement: a dependency whose citing events are all gone
  // from current state (superseded/rejected) no longer holds.
  const open = await deps.db
    .select()
    .from(tables.dependencies)
    .where(eq(tables.dependencies.status, "open"));
  let resolved = 0;
  for (const dep of open) {
    const eventIds = ((dep.refs as { eventIds?: string[] }).eventIds ?? []).filter(Boolean);
    if (eventIds.length === 0) continue;
    const [active] = await deps.db
      .select({ id: tables.events.id })
      .from(tables.events)
      .where(and(inArray(tables.events.id, eventIds), eq(tables.events.status, "active")))
      .limit(1);
    if (!active) {
      await deps.db
        .update(tables.dependencies)
        .set({ status: "resolved", resolvedAt: now })
        .where(eq(tables.dependencies.id, dep.id));
      resolved++;
    }
  }
  return { detected, resolved };
}

// --- Change impact (deterministic) ---

/** Open dependencies whose prerequisite project shows active trouble. */
export async function changeImpact(deps: WorkerDeps): Promise<Finding[]> {
  const open = await deps.db
    .select({
      id: tables.dependencies.id,
      summary: tables.dependencies.summary,
      dependentProjectId: tables.dependencies.dependentProjectId,
      prerequisiteProjectId: tables.dependencies.prerequisiteProjectId,
      prerequisiteName: tables.projects.name,
    })
    .from(tables.dependencies)
    .innerJoin(tables.projects, eq(tables.projects.id, tables.dependencies.prerequisiteProjectId))
    .where(eq(tables.dependencies.status, "open"));

  const findings: Finding[] = [];
  for (const dep of open) {
    const causes = await deps.db
      .select({
        id: tables.events.id,
        type: tables.events.type,
        title: tables.events.title,
      })
      .from(tables.events)
      .innerJoin(tables.eventProjects, eq(tables.eventProjects.eventId, tables.events.id))
      .where(
        and(
          eq(tables.eventProjects.projectId, dep.prerequisiteProjectId),
          eq(tables.events.status, "active"),
          inArray(tables.events.type, ["deadline_slipped", "blocker_raised"]),
        ),
      );
    for (const cause of causes) {
      findings.push({
        kind: "change_impact",
        dedupeKey: `change_impact:${dep.id}:${cause.id}`,
        projectId: dep.dependentProjectId,
        summary: `Upstream trouble in ${dep.prerequisiteName}: ${cause.title}`,
        detail: `This project depends on ${dep.prerequisiteName} (${dep.summary}), which has an active ${cause.type.replace(/_/g, " ")}.`,
        refs: { dependencyId: dep.id, eventIds: [cause.id] },
      });
    }
  }
  return findings;
}

// --- Design-to-implementation gaps (LLM) ---

const classifySchema = z.object({
  is_design_doc: z.boolean(),
  project_slug: z.string().nullable(),
});

const CLASSIFY_TOOL: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "classify_document",
        description: "Classify whether this is a design/scope document and for which project.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              is_design_doc: {
                type: "boolean",
                description:
                  "true only for documents describing planned scope, designs, or deliverables — not transcripts, notes, or status updates",
              },
              project_slug: {
                type: "string",
                description: "the project this document belongs to, from the provided list; null if unclear",
              },
            },
            required: ["is_design_doc"],
          },
        },
      },
    },
  ],
  toolChoice: { tool: { name: "classify_document" } },
};

// Lenient by design: an over-eager model (too many gaps, long text) gets
// clamped, not discarded — a failed parse here silently drops real findings.
const gapSchema = z.object({
  gaps: z.array(
    z.object({
      summary: z.string().min(10).transform((s) => s.slice(0, 300)),
      detail: z
        .string()
        .transform((s) => s.slice(0, 1000))
        .optional(),
    }),
  ),
});
const MAX_GAPS_PER_DOC = 8;

const GAP_TOOL: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "emit_gaps",
        description: "Emit design-scope items with no corresponding tracked work.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              gaps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    summary: {
                      type: "string",
                      description: "One line: the scope the design describes that no work item covers.",
                    },
                    detail: { type: "string", description: "The design's wording, briefly." },
                  },
                  required: ["summary"],
                },
              },
            },
            required: ["gaps"],
          },
        },
      },
    },
  ],
  toolChoice: { tool: { name: "emit_gaps" } },
};

const GAP_SYSTEM = `You compare a design document against a project's tracked work items (Jira issues, GitLab issues/MRs) for an engineering org's knowledge base.

Report scope the design explicitly commits to (deliverables, features, phases) that NO tracked work item plausibly covers. Match generously — differently-worded items covering the same scope are covered. Do not report background, context, non-committal ideas, or scope that work items already cover. Nothing missing → empty gaps array.`;

interface GapResult {
  findings: Finding[];
  docsAnalyzed: number;
}

export async function designGaps(deps: WorkerDeps): Promise<GapResult> {
  if (!deps.llm) {
    deps.logger.warn("llm unavailable; skipping design-gap check");
    return { findings: [], docsAnalyzed: 0 };
  }

  // Watched-drive docs not yet analyzed (connector_state marker per artifact).
  const docs = await deps.db
    .select({
      id: tables.rawArtifacts.id,
      sourceKey: tables.rawArtifacts.sourceKey,
      objectKey: tables.rawArtifacts.objectKey,
    })
    .from(tables.rawArtifacts)
    .where(
      and(
        eq(tables.rawArtifacts.source, "gws"),
        like(tables.rawArtifacts.sourceKey, "gws:drive:%"),
        sql`not exists (
          select 1 from ${tables.connectorState}
          where ${tables.connectorState.key} = 'analyst:gap:' || ${tables.rawArtifacts.id}
        )`,
      ),
    )
    .orderBy(desc(tables.rawArtifacts.collectedAt))
    .limit(GAP_DOCS_PER_PASS);

  const projectRows = await deps.db
    .select({ id: tables.projects.id, slug: tables.projects.slug, name: tables.projects.name })
    .from(tables.projects);
  const bySlug = new Map(projectRows.map((p) => [p.slug, p]));

  const findings: Finding[] = [];
  let docsAnalyzed = 0;
  for (const doc of docs) {
    const markAnalyzed = () =>
      deps.db
        .insert(tables.connectorState)
        .values({ key: `analyst:gap:${doc.id}`, value: { analyzedAt: new Date().toISOString() } })
        .onConflictDoNothing();

    const envelope = await getRawArtifact(deps, doc.objectKey);
    const payload = envelope.payload as { fileName?: string; content?: string };
    const text = payload.content?.slice(0, 16_000);
    // sourceKey: gws:drive:<fileId>:<modifiedTime> — key gap findings to the
    // file so a newer revision retires findings from older ones.
    const fileId = doc.sourceKey.split(":")[2] ?? doc.id;
    if (!text || text.length < 500) {
      await markAnalyzed();
      continue;
    }

    const classifyRes = await deps.llm.invoke("linter", {
      system:
        "You classify documents for an engineering org. Project slugs: " +
        projectRows.map((p) => `${p.slug} (${p.name})`).join(", "),
      messages: [
        {
          role: "user",
          content: [{ text: `Document "${payload.fileName ?? "untitled"}":\n${text.slice(0, 6_000)}` }],
        },
      ],
      toolConfig: CLASSIFY_TOOL,
      purpose: `lint:gap-classify:${doc.id}`,
    });
    docsAnalyzed++;
    const classifyUse = classifyRes.message?.content?.find((c) => c.toolUse)?.toolUse;
    const classified = classifySchema.safeParse(classifyUse?.input);
    const project = classified.success && classified.data.project_slug
      ? bySlug.get(classified.data.project_slug)
      : undefined;
    if (!classified.success || !classified.data.is_design_doc || !project) {
      await markAnalyzed();
      continue;
    }

    const items = await deps.db
      .select()
      .from(tables.workItems)
      .where(eq(tables.workItems.projectId, project.id))
      .orderBy(sql`${tables.workItems.sourceUpdatedAt} desc nulls last`)
      .limit(100);
    const itemLines =
      items.length > 0
        ? items
            .map((w) => `- ${w.reference ?? w.sourceId} [${w.state}] ${w.title}`)
            .join("\n")
        : "(no tracked work items exist for this project)";

    const gapRes = await deps.llm.invoke("linter", {
      system: GAP_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              text: `Project: ${project.name}\n\n== Design document "${payload.fileName ?? "untitled"}" ==\n${text}\n\n== Tracked work items ==\n${itemLines}`,
            },
          ],
        },
      ],
      toolConfig: GAP_TOOL,
      purpose: `lint:gap:${doc.id}`,
    });
    const gapUse = gapRes.message?.content?.find((c) => c.toolUse)?.toolUse;
    const parsed = gapSchema.safeParse(gapUse?.input);
    if (parsed.success) {
      const permalink = (envelope.sourceMeta as { permalink?: string }).permalink;
      for (const g of parsed.data.gaps.slice(0, MAX_GAPS_PER_DOC)) {
        const digest = g.summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
        findings.push({
          kind: "design_gap",
          dedupeKey: `design_gap:${doc.id}:${digest}`,
          projectId: project.id,
          summary: g.summary,
          detail: [g.detail, permalink ? `Design: ${permalink}` : null].filter(Boolean).join(" · "),
          refs: { artifactId: doc.id, fileId, fileName: payload.fileName, permalink },
        });
      }
      // A re-analyzed newer revision retires findings from prior revisions.
      await deps.db
        .update(tables.lintFindings)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(
          and(
            eq(tables.lintFindings.status, "open"),
            eq(tables.lintFindings.kind, "design_gap"),
            sql`${tables.lintFindings.refs}->>'fileId' = ${fileId}`,
            sql`${tables.lintFindings.refs}->>'artifactId' <> ${doc.id}`,
          ),
        );
    } else {
      deps.logger.warn(
        { artifactId: doc.id, issues: parsed.error.issues.slice(0, 3) },
        "gap output failed validation; doc marked analyzed",
      );
    }
    await markAnalyzed();
  }

  return { findings, docsAnalyzed };
}

/**
 * Reporter agent (task 4.8): portfolio and per-team status reports.
 *
 * Single write surface (brain-agents spec): report rows. Every generation is
 * a new immutable draft snapshot citing the events it draws on; publishing is
 * an explicit human action in the web app (D4 — never automatic). Frontier
 * tier, budget-capped like every other agent. Invalid model output is retried
 * once with feedback, then dropped without writing (no partial reports).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { tables } from "@second-brain/schema";
import { z } from "zod";
import type { WorkerDeps } from "./lib/deps.ts";
import { retryFeedback } from "./lib/llm.ts";
import { emitMetric } from "./lib/metrics.ts";
import { slackRewriter } from "./lib/slack-people.ts";

const EVENTS_PER_PROJECT = Number(process.env.REPORT_EVENTS_PER_PROJECT ?? 15);

export interface ReportRequest {
  scope: "portfolio" | "team";
  teamId?: string;
  requestedById?: string;
}

const reportSchema = z.object({
  title: z.string().min(5).transform((s) => s.slice(0, 200)),
  body_markdown: z.string().min(100),
  slides: z
    .array(
      z.object({
        title: z.string().min(1).transform((s) => s.slice(0, 120)),
        bullets: z.array(z.string().min(1).transform((s) => s.slice(0, 300))).min(1).max(8),
      }),
    )
    .min(3)
    .max(15),
  cited_event_ids: z.array(z.string().uuid()).min(1),
});

const REPORT_TOOL = {
  tools: [
    {
      toolSpec: {
        name: "emit_report",
        description: "Emit the status report document and slide outline.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              title: { type: "string", description: "Report title including the date." },
              body_markdown: {
                type: "string",
                description:
                  "Full report document in markdown. Cite supporting events inline as [event:<id>].",
              },
              slides: {
                type: "array",
                description: "Slide outline for a presentation version of the report.",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    bullets: { type: "array", items: { type: "string" } },
                  },
                  required: ["title", "bullets"],
                },
              },
              cited_event_ids: {
                type: "array",
                items: { type: "string" },
                description: "Every event id the report draws on.",
              },
            },
            required: ["title", "body_markdown", "slides", "cited_event_ids"],
          },
        },
      },
    },
  ],
  toolChoice: { tool: { name: "emit_report" } },
} as const;

const SYSTEM = `You write executive status reports for an engineering organization's leadership, from the org's knowledge base. You receive per-project data: status, priority, POC, the current status narrative, recent typed events (each with an id), open blockers, cross-project dependencies, and open inconsistency findings.

Rules:
- Audience is leadership: lead with what changed and what needs attention, not a project-by-project data dump. Concise, factual, present tense.
- Structure the document: executive summary, items needing attention (blockers, slipped deadlines, risks), then per-team or per-project highlights, then outlook.
- Every factual claim must trace to the provided data. Cite events inline as [event:<id>] and list every used id in cited_event_ids. Never invent facts, dates, or numbers.
- The slide outline condenses the same content: one title slide, one executive summary, then one slide per major theme; bullets are single statements, no citations markers in bullets.
- Confidence below 0.5 → hedge the claim ("reportedly", "unverified").`;

interface ProjectBundle {
  id: string;
  name: string;
  slug: string;
  status: string;
  priority: string;
  teamName: string | null;
  pocName: string | null;
  narrative: string;
  events: { id: string; type: string; title: string; body: string | null; confidence: number; occurredAt: Date | null }[];
  findings: { kind: string; summary: string }[];
}

async function gatherProjects(deps: WorkerDeps, teamId?: string): Promise<ProjectBundle[]> {
  const projectRows = await deps.db
    .select({
      id: tables.projects.id,
      name: tables.projects.name,
      slug: tables.projects.slug,
      status: tables.projects.status,
      priority: tables.projects.priority,
      teamName: tables.teams.name,
      pocId: tables.projects.pocId,
    })
    .from(tables.projects)
    .leftJoin(tables.teams, eq(tables.teams.id, tables.projects.teamId))
    .where(teamId ? eq(tables.projects.teamId, teamId) : undefined);

  const pocIds = [...new Set(projectRows.map((p) => p.pocId).filter((x): x is string => !!x))];
  const pocs = pocIds.length
    ? await deps.db
        .select({ id: tables.people.id, name: tables.people.displayName })
        .from(tables.people)
        .where(inArray(tables.people.id, pocIds))
    : [];
  const pocName = new Map(pocs.map((p) => [p.id, p.name]));

  const bundles: ProjectBundle[] = [];
  for (const p of projectRows) {
    // Current status narrative (head revision), clipped as background context.
    const [narrative] = await deps.db
      .select({ currentRevisionId: tables.narratives.currentRevisionId })
      .from(tables.narratives)
      .where(and(eq(tables.narratives.projectId, p.id), eq(tables.narratives.kind, "status")));
    let narrativeBody = "";
    if (narrative?.currentRevisionId) {
      const [rev] = await deps.db
        .select({ body: tables.narrativeRevisions.body })
        .from(tables.narrativeRevisions)
        .where(eq(tables.narrativeRevisions.id, narrative.currentRevisionId));
      narrativeBody = rev?.body ?? "";
    }

    const events = await deps.db
      .select({
        id: tables.events.id,
        type: tables.events.type,
        title: tables.events.title,
        body: tables.events.body,
        confidence: tables.events.confidence,
        occurredAt: tables.events.occurredAt,
      })
      .from(tables.events)
      .innerJoin(tables.eventProjects, eq(tables.eventProjects.eventId, tables.events.id))
      .where(and(eq(tables.eventProjects.projectId, p.id), eq(tables.events.status, "active")))
      .orderBy(desc(tables.events.extractedAt))
      .limit(EVENTS_PER_PROJECT);

    const findings = await deps.db
      .select({ kind: tables.lintFindings.kind, summary: tables.lintFindings.summary })
      .from(tables.lintFindings)
      .where(
        and(eq(tables.lintFindings.projectId, p.id), eq(tables.lintFindings.status, "open")),
      )
      .limit(10);

    // Projects with no knowledge at all contribute nothing to a status report.
    if (events.length === 0 && !narrativeBody) continue;

    bundles.push({
      id: p.id,
      name: p.name,
      slug: p.slug,
      status: p.status,
      priority: p.priority,
      teamName: p.teamName,
      pocName: p.pocId ? (pocName.get(p.pocId) ?? null) : null,
      narrative: narrativeBody,
      events,
      findings,
    });
  }
  return bundles;
}

/**
 * Narrative bodies carry [event:<id>] citation markers whose ids may point at
 * superseded events outside the report's event list; the model was copying
 * them into cited_event_ids and failing validation. Reports must cite only
 * from the provided events, so the markers are noise here.
 */
function stripEventMarkers(s: string): string {
  return s.replace(/\s*\[event:[0-9a-fA-F-]{36}\]/g, "");
}

function renderPrompt(
  scopeLabel: string,
  bundles: ProjectBundle[],
  dependencies: { summary: string; dependentName: string; prerequisiteName: string }[],
): string {
  const sections = bundles.map((b) => {
    const events = b.events
      .map(
        (e) =>
          `  - id=${e.id} [${e.type}] (confidence ${e.confidence}${e.occurredAt ? `, occurred ${e.occurredAt.toISOString().slice(0, 10)}` : ""}) ${e.title}${e.body ? ` — ${e.body.slice(0, 200)}` : ""}`,
      )
      .join("\n");
    const findings = b.findings.map((f) => `  - [${f.kind}] ${f.summary}`).join("\n");
    return `## ${b.name} (${b.slug})
Team: ${b.teamName ?? "unassigned"} | Status: ${b.status} | Priority: ${b.priority} | POC: ${b.pocName ?? "none"}

Current narrative:
${b.narrative ? stripEventMarkers(b.narrative).slice(0, 2000) : "(none)"}

Recent events (newest first):
${events || "  (none)"}

Open findings:
${findings || "  (none)"}`;
  });

  const deps_ = dependencies
    .map((d) => `- ${d.dependentName} depends on ${d.prerequisiteName}: ${d.summary}`)
    .join("\n");

  return `Generate a ${scopeLabel} status report dated ${new Date().toISOString().slice(0, 10)}.

Cross-project dependencies:
${deps_ || "(none)"}

${sections.join("\n\n")}`;
}

export async function generateReport(
  deps: WorkerDeps,
  request: ReportRequest,
): Promise<{ reportId?: string; skipped?: string }> {
  if (!deps.llm) throw new Error("llm not configured; cannot generate reports");

  let scopeLabel = "portfolio";
  let teamName: string | undefined;
  if (request.scope === "team") {
    if (!request.teamId) throw new Error("team report needs a teamId");
    const [team] = await deps.db
      .select({ name: tables.teams.name })
      .from(tables.teams)
      .where(eq(tables.teams.id, request.teamId));
    if (!team) throw new Error(`report: no team ${request.teamId}`);
    teamName = team.name;
    scopeLabel = `${team.name} team`;
  }

  const bundles = await gatherProjects(deps, request.teamId);
  if (bundles.length === 0) {
    deps.logger.info({ scope: request.scope }, "no projects with knowledge; skipping report");
    return { skipped: "no projects with knowledge" };
  }

  const projectIds = bundles.map((b) => b.id);
  const dependencyRows = await deps.db
    .select({
      summary: tables.dependencies.summary,
      dependentProjectId: tables.dependencies.dependentProjectId,
      prerequisiteProjectId: tables.dependencies.prerequisiteProjectId,
    })
    .from(tables.dependencies)
    .where(
      and(
        eq(tables.dependencies.status, "open"),
        inArray(tables.dependencies.dependentProjectId, projectIds),
      ),
    );
  const nameById = new Map(bundles.map((b) => [b.id, b.name]));
  const dependencies = dependencyRows.map((d) => ({
    summary: d.summary,
    dependentName: nameById.get(d.dependentProjectId) ?? "another project",
    prerequisiteName: nameById.get(d.prerequisiteProjectId) ?? "another project",
  }));

  const eventIds = new Set(bundles.flatMap((b) => b.events.map((e) => e.id)));
  const rawPrompt = renderPrompt(scopeLabel, bundles, dependencies);
  const namePrompt = await slackRewriter(deps.db, [rawPrompt]);
  const prompt = namePrompt(rawPrompt).slice(0, 150_000);

  const messages: Parameters<NonNullable<WorkerDeps["llm"]>["invoke"]>[1]["messages"] = [
    { role: "user", content: [{ text: prompt }] },
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await deps.llm.invoke("reporter", {
      system: SYSTEM,
      messages,
      toolConfig: REPORT_TOOL as never,
      maxTokens: 8000,
      temperature: 0.2,
      purpose: `report:${request.scope}${teamName ? `:${teamName}` : ""}`,
    });

    const toolUse = response.message?.content?.find((b) => b.toolUse)?.toolUse;
    const parsed = reportSchema.safeParse(toolUse?.input);
    const idsValid =
      parsed.success && parsed.data.cited_event_ids.every((id) => eventIds.has(id));

    if (parsed.success && idsValid) {
      const rewrite = await slackRewriter(deps.db, [
        parsed.data.title,
        parsed.data.body_markdown,
        ...parsed.data.slides.flatMap((s) => [s.title, ...s.bullets]),
      ]);
      const [row] = await deps.db
        .insert(tables.reports)
        .values({
          scope: request.scope,
          teamId: request.teamId,
          title: rewrite(parsed.data.title),
          body: rewrite(parsed.data.body_markdown),
          slides: parsed.data.slides.map((s) => ({
            title: rewrite(s.title),
            bullets: s.bullets.map((b) => rewrite(b)),
          })),
          citedEventIds: parsed.data.cited_event_ids,
          requestedById: request.requestedById,
          createdBy: `reporter:${response.modelId}`,
        })
        .returning({ id: tables.reports.id });
      emitMetric("reports_generated", 1, { stage: "report" });
      deps.logger.info(
        { reportId: row!.id, scope: request.scope, teamName, projects: bundles.length },
        "report draft created",
      );
      return { reportId: row!.id };
    }

    const error = parsed.success
      ? "cited_event_ids contains ids not present in the provided events"
      : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500);
    deps.logger.warn({ scope: request.scope, attempt, error }, "report output failed validation");
    messages.push(
      { role: "assistant", content: response.message?.content ?? [{ text: response.text }] },
      retryFeedback(
        toolUse?.toolUseId,
        `Your emit_report call failed validation: ${error}. Call emit_report again with corrected input; only cite event ids from the provided data.`,
      ),
    );
  }

  emitMetric("report_failed", 1, { stage: "report" });
  deps.logger.error({ scope: request.scope }, "report failed validation twice; nothing written");
  return { skipped: "validation failed twice" };
}

/** Age guard for the scheduler: true when the newest portfolio report is older than maxAgeMs. */
export async function portfolioReportDue(deps: WorkerDeps, maxAgeMs: number): Promise<boolean> {
  const [latest] = await deps.db
    .select({ createdAt: tables.reports.createdAt })
    .from(tables.reports)
    .where(eq(tables.reports.scope, "portfolio"))
    .orderBy(desc(tables.reports.createdAt))
    .limit(1);
  if (!latest) return true;
  return Date.now() - latest.createdAt.getTime() > maxAgeMs;
}

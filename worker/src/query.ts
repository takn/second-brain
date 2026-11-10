/**
 * Query agent (task 5.7): asynchronous ask-the-brain.
 *
 * A small tool loop over the brain (web-app spec: "the index, structured
 * queries, and raw source drill-down"): the model searches the FTS index
 * (search_brain), drills into per-project structured state (project_status),
 * then must emit_answer with [event:<id>] citations drawn only from events it
 * actually saw. Single write surface (brain-agents spec): the brain_queries
 * row — saving an answer as an analysis is a separate explicit human action
 * in the web app.
 *
 * Frontier tier, budget-capped. BudgetExhaustedError propagates so the job
 * re-queues with delay and the query stays pending. Validation failures get
 * one retryFeedback; a second failure (or turn exhaustion) marks the row
 * failed — never a partial answer.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { tables } from "@second-brain/schema";
import { z } from "zod";
import type { ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";
import type { WorkerDeps } from "./lib/deps.ts";
import { retryFeedback } from "./lib/llm.ts";
import { emitMetric } from "./lib/metrics.ts";
import { slackRewriter } from "./lib/slack-people.ts";

const MAX_TURNS = Number(process.env.QUERY_MAX_TURNS ?? 6);

const answerSchema = z.object({
  answer_markdown: z.string().min(30),
  cited_event_ids: z.array(z.string().uuid()),
});

const TOOLS: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "search_brain",
        description:
          "Full-text search over the org knowledge base: typed events, current project narratives, and projects. Returns matches with ids and excerpts.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search terms (plain words work best; quoted phrases supported).",
              },
            },
            required: ["query"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "project_status",
        description:
          "Structured drill-down for one project by slug: status, priority, POC, current narrative, active blockers and deadlines (with event ids), and open cross-project dependencies.",
        inputSchema: {
          json: {
            type: "object",
            properties: { slug: { type: "string", description: "Project slug." } },
            required: ["slug"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "emit_answer",
        description:
          "Emit the final answer once the question can be answered from gathered evidence.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              answer_markdown: {
                type: "string",
                description:
                  "The answer in markdown. Cite supporting events inline as [event:<id>]. If the brain has no relevant knowledge, say so plainly.",
              },
              cited_event_ids: {
                type: "array",
                items: { type: "string" },
                description:
                  "Every event id the answer draws on (empty only for no-knowledge answers).",
              },
            },
            required: ["answer_markdown", "cited_event_ids"],
          },
        },
      },
    },
  ],
  toolChoice: { any: {} },
};

const SYSTEM = `You answer questions about an engineering organization using its knowledge base. You have tools: search_brain (full-text search over events, narratives, projects), project_status (structured per-project state), and emit_answer (your final answer).

Rules:
- Gather evidence first: search for the question's key terms, drill into relevant projects, then answer. Refine searches if the first returns nothing useful.
- Every factual claim must trace to evidence you retrieved. Cite events inline as [event:<id>] using ids from tool results, and list every used id in cited_event_ids. Never invent facts or ids.
- Events carry confidence; below 0.5 hedge the claim ("reportedly", "unverified").
- If the brain has no relevant knowledge, emit an answer saying exactly that — do not speculate.
- Be direct and concise; the asker is an internal leader who wants the state of things, not a essay.`;

/** Strip [event:id] markers — narrative excerpts must not leak citable-looking ids. */
function stripMarkers(s: string): string {
  return s.replace(/\s*\[event:[0-9a-fA-F-]{36}\]/g, "");
}

export async function searchBrain(
  deps: WorkerDeps,
  query: string,
  seenEventIds: Set<string>,
): Promise<unknown> {
  const ts = (expr: ReturnType<typeof sql>) =>
    sql`${expr} @@ websearch_to_tsquery('english', ${query})`;

  const [events, narratives, projects] = await Promise.all([
    deps.db
      .select({
        id: tables.events.id,
        type: tables.events.type,
        title: tables.events.title,
        body: tables.events.body,
        confidence: tables.events.confidence,
        occurredAt: tables.events.occurredAt,
      })
      .from(tables.events)
      .where(
        and(
          eq(tables.events.status, "active"),
          ts(
            sql`to_tsvector('english', ${tables.events.title} || ' ' || coalesce(${tables.events.body}, ''))`,
          ),
        ),
      )
      .orderBy(desc(tables.events.extractedAt))
      .limit(12),
    deps.db
      .select({
        body: tables.narrativeRevisions.body,
        projectName: tables.projects.name,
        projectSlug: tables.projects.slug,
      })
      .from(tables.narrativeRevisions)
      .innerJoin(tables.narratives, eq(tables.narratives.id, tables.narrativeRevisions.narrativeId))
      .innerJoin(tables.projects, eq(tables.projects.id, tables.narratives.projectId))
      .where(
        and(
          sql`${tables.narrativeRevisions.id} = ${tables.narratives.currentRevisionId}`,
          ts(
            sql`to_tsvector('english', coalesce(${tables.narrativeRevisions.summary}, '') || ' ' || ${tables.narrativeRevisions.body})`,
          ),
        ),
      )
      .limit(4),
    deps.db
      .select({
        slug: tables.projects.slug,
        name: tables.projects.name,
        status: tables.projects.status,
        priority: tables.projects.priority,
      })
      .from(tables.projects)
      .where(
        ts(
          sql`to_tsvector('english', ${tables.projects.name} || ' ' || coalesce(${tables.projects.description}, ''))`,
        ),
      )
      .limit(5),
  ]);

  for (const e of events) seenEventIds.add(e.id);
  const rewrite = await slackRewriter(deps.db, [
    ...events.flatMap((e) => [e.title, e.body ?? ""]),
    ...narratives.map((n) => n.body),
  ]);
  return {
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      title: rewrite(e.title),
      body: e.body ? rewrite(e.body).slice(0, 300) : null,
      confidence: e.confidence,
      occurred_at: e.occurredAt?.toISOString().slice(0, 10) ?? null,
    })),
    narratives: narratives.map((n) => ({
      project_slug: n.projectSlug,
      project_name: n.projectName,
      excerpt: stripMarkers(rewrite(n.body)).slice(0, 1200),
    })),
    projects,
  };
}

export async function projectStatus(
  deps: WorkerDeps,
  slug: string,
  seenEventIds: Set<string>,
): Promise<unknown> {
  const [project] = await deps.db
    .select()
    .from(tables.projects)
    .where(eq(tables.projects.slug, slug));
  if (!project) return { error: `no project with slug "${slug}"` };

  const [narrative] = await deps.db
    .select({ currentRevisionId: tables.narratives.currentRevisionId })
    .from(tables.narratives)
    .where(and(eq(tables.narratives.projectId, project.id), eq(tables.narratives.kind, "status")));
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
      confidence: tables.events.confidence,
      occurredAt: tables.events.occurredAt,
    })
    .from(tables.events)
    .innerJoin(tables.eventProjects, eq(tables.eventProjects.eventId, tables.events.id))
    .where(
      and(
        eq(tables.eventProjects.projectId, project.id),
        eq(tables.events.status, "active"),
        inArray(tables.events.type, [
          "blocker_raised",
          "blocker_resolved",
          "deadline_set",
          "deadline_slipped",
        ]),
      ),
    )
    .orderBy(desc(tables.events.extractedAt))
    .limit(15);
  for (const e of events) seenEventIds.add(e.id);

  const deps_ = await deps.db
    .select({
      summary: tables.dependencies.summary,
      dependentProjectId: tables.dependencies.dependentProjectId,
    })
    .from(tables.dependencies)
    .where(
      and(
        eq(tables.dependencies.status, "open"),
        sql`(${tables.dependencies.dependentProjectId} = ${project.id} or ${tables.dependencies.prerequisiteProjectId} = ${project.id})`,
      ),
    )
    .limit(10);

  let pocName: string | null = null;
  if (project.pocId) {
    const [poc] = await deps.db
      .select({ name: tables.people.displayName })
      .from(tables.people)
      .where(eq(tables.people.id, project.pocId));
    pocName = poc?.name ?? null;
  }

  const rewrite = await slackRewriter(deps.db, [
    narrativeBody,
    ...events.map((e) => e.title),
    ...deps_.map((d) => d.summary),
  ]);

  return {
    slug: project.slug,
    name: project.name,
    status: project.status,
    priority: project.priority,
    poc: pocName,
    narrative: stripMarkers(rewrite(narrativeBody)).slice(0, 3000) || "(none yet)",
    blocker_and_deadline_events: events.map((e) => ({
      id: e.id,
      type: e.type,
      title: rewrite(e.title),
      confidence: e.confidence,
      occurred_at: e.occurredAt?.toISOString().slice(0, 10) ?? null,
    })),
    open_dependencies: deps_.map((d) => ({
      direction: d.dependentProjectId === project.id ? "waiting_on_other" : "other_waits_on_us",
      summary: rewrite(d.summary),
    })),
  };
}

export async function answerQuery(
  deps: WorkerDeps,
  queryId: string,
): Promise<{ status: "answered" | "failed"; turns: number }> {
  if (!deps.llm) throw new Error("llm not configured; cannot answer queries");

  const [row] = await deps.db
    .select()
    .from(tables.brainQueries)
    .where(eq(tables.brainQueries.id, queryId));
  if (!row) throw new Error(`query: no brain_queries row ${queryId}`);
  if (row.status === "answered") return { status: "answered", turns: 0 };

  const seenEventIds = new Set<string>();
  let validationRetries = 0;
  const messages: Parameters<NonNullable<WorkerDeps["llm"]>["invoke"]>[1]["messages"] = [
    { role: "user", content: [{ text: `Question: ${row.question.slice(0, 2000)}` }] },
  ];

  const fail = async (error: string, turns: number) => {
    await deps.db
      .update(tables.brainQueries)
      .set({ status: "failed", error })
      .where(eq(tables.brainQueries.id, queryId));
    emitMetric("query_failed", 1, { stage: "query" });
    deps.logger.error({ queryId, error }, "query failed");
    return { status: "failed" as const, turns };
  };

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const lastTurn = turn === MAX_TURNS;
    const response = await deps.llm.invoke("query", {
      system: SYSTEM,
      messages,
      toolConfig: (lastTurn
        ? { ...TOOLS, toolChoice: { tool: { name: "emit_answer" } } }
        : TOOLS) as never,
      maxTokens: 4000,
      temperature: 0,
      purpose: `query:${queryId}`,
    });

    // The model may call several tools in one turn (e.g. parallel searches);
    // Bedrock requires a toolResult for EVERY toolUse id in the next message.
    const toolUses =
      response.message?.content?.flatMap((b) => (b.toolUse ? [b.toolUse] : [])) ?? [];
    if (toolUses.length === 0) {
      return fail("model produced no tool call", turn);
    }
    messages.push({
      role: "assistant",
      content: response.message?.content ?? [{ text: response.text }],
    });

    let emitError = "";
    const emit = toolUses.find((t) => t.name === "emit_answer");
    if (emit) {
      const parsed = answerSchema.safeParse(emit.input);
      const idsValid =
        parsed.success && parsed.data.cited_event_ids.every((id) => seenEventIds.has(id));
      if (parsed.success && idsValid) {
        await deps.db
          .update(tables.brainQueries)
          .set({
            status: "answered",
            answer: parsed.data.answer_markdown,
            citedEventIds: parsed.data.cited_event_ids,
            answeredBy: `query:${response.modelId}`,
            answeredAt: new Date(),
          })
          .where(eq(tables.brainQueries.id, queryId));
        emitMetric("queries_answered", 1, { stage: "query" });
        deps.logger.info({ queryId, turns: turn }, "query answered");
        return { status: "answered", turns: turn };
      }

      emitError = parsed.success
        ? "cited_event_ids contains ids that did not appear in any tool result"
        : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400);
      if (++validationRetries > 1) {
        return fail(`answer failed validation twice: ${emitError}`, turn);
      }
      deps.logger.warn({ queryId, turn, error: emitError }, "query answer failed validation");
    }

    // One user message answering every tool call: evidence results for the
    // gathering tools, error feedback for a rejected emit_answer.
    const resultBlocks: NonNullable<
      Parameters<NonNullable<WorkerDeps["llm"]>["invoke"]>[1]["messages"][number]["content"]
    > = [];
    for (const toolUse of toolUses) {
      if (toolUse.name === "emit_answer") {
        const feedback = retryFeedback(
          toolUse.toolUseId,
          `Your emit_answer call failed validation: ${emitError}. Call emit_answer again; cite only event ids returned by your tool calls.`,
        );
        resultBlocks.push(...(feedback.content ?? []));
        continue;
      }
      let result: unknown;
      if (toolUse.name === "search_brain") {
        const q = String((toolUse.input as { query?: unknown })?.query ?? "").slice(0, 300);
        result = q ? await searchBrain(deps, q, seenEventIds) : { error: "query is required" };
      } else if (toolUse.name === "project_status") {
        const slug = String((toolUse.input as { slug?: unknown })?.slug ?? "");
        result = slug
          ? await projectStatus(deps, slug, seenEventIds)
          : { error: "slug is required" };
      } else {
        result = { error: `unknown tool ${toolUse.name}` };
      }
      resultBlocks.push({
        toolResult: {
          toolUseId: toolUse.toolUseId,
          content: [{ text: JSON.stringify(result).slice(0, 30_000) }],
        },
      });
    }
    messages.push({ role: "user", content: resultBlocks });
  }

  return fail(`no answer after ${MAX_TURNS} turns`, MAX_TURNS);
}

/**
 * Stale-pending sweep: a query whose job died (DLQ, crash, lost message) has
 * nothing left to flip its row, so the UI would show "thinking…" forever.
 * Run from the worker scheduler; anything pending longer than maxAgeMs is
 * marked failed with a re-ask hint. Re-enqueued jobs that later run against a
 * swept row simply overwrite failed → answered, so the sweep is safe.
 */
export async function failStalePendingQueries(
  deps: WorkerDeps,
  maxAgeMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const swept = await deps.db
    .update(tables.brainQueries)
    .set({
      status: "failed",
      error: "the answering job did not complete — ask again",
    })
    .where(
      and(
        eq(tables.brainQueries.status, "pending"),
        lt(tables.brainQueries.createdAt, cutoff),
      ),
    )
    .returning({ id: tables.brainQueries.id });
  if (swept.length > 0) {
    emitMetric("queries_swept_stale", swept.length, { stage: "query" });
    deps.logger.warn({ count: swept.length }, "marked stale pending queries failed");
  }
  return swept.length;
}

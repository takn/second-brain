/**
 * Synthesizer agent (task 4.4): per-project status narrative regeneration.
 *
 * Serialization (brain-agents spec: at most one synthesis per project at a
 * time) is structural in v1 — a single worker task processes queue messages
 * sequentially. Debounce: synthesize jobs are enqueued with an SQS delay, and
 * a skip-guard exits without an LLM call when no active events are newer than
 * the current revision, so a burst of queued jobs collapses into one pass.
 *
 * Single write surface: narrative revisions (with event citations via
 * createNarrativeRevision), supersede marks on events, contradiction rows.
 * Invalid model output is retried once with feedback; a second failure leaves
 * the narrative untouched (no partial writes) and surfaces a metric.
 */
import { and, desc, eq } from "drizzle-orm";
import { createNarrativeRevision, tables } from "@second-brain/schema";
import { z } from "zod";
import { synthesisCorrections } from "./lib/corrections.ts";
import type { WorkerDeps } from "./lib/deps.ts";
import { retryFeedback } from "./lib/llm.ts";
import { emitMetric } from "./lib/metrics.ts";
import { slackRewriter } from "./lib/slack-people.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Model output often overshoots summary length or slips non-UUIDs into citation
 * arrays. Sanitize before zod so one bad id doesn't sink the whole revision.
 */
export function sanitizeSynthesisInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };

  if (typeof o.summary === "string" && o.summary.length > 500) {
    o.summary = o.summary.slice(0, 500);
  }

  if (Array.isArray(o.cited_event_ids)) {
    o.cited_event_ids = o.cited_event_ids.filter(isUuid);
  }

  if (Array.isArray(o.superseded)) {
    o.superseded = o.superseded.filter(
      (row) =>
        row &&
        typeof row === "object" &&
        isUuid((row as { old_event_id?: unknown }).old_event_id) &&
        isUuid((row as { new_event_id?: unknown }).new_event_id),
    );
  }

  if (Array.isArray(o.contradictions)) {
    o.contradictions = o.contradictions
      .filter(
        (row) =>
          row &&
          typeof row === "object" &&
          isUuid((row as { event_a_id?: unknown }).event_a_id) &&
          isUuid((row as { event_b_id?: unknown }).event_b_id),
      )
      .map((row) => {
        const c = { ...(row as Record<string, unknown>) };
        if (typeof c.summary === "string" && c.summary.length > 500) {
          c.summary = c.summary.slice(0, 500);
        }
        if (typeof c.resolution === "string" && c.resolution.length > 1000) {
          c.resolution = c.resolution.slice(0, 1000);
        }
        return c;
      });
  }

  return o;
}

const synthesisSchema = z.object({
  narrative_markdown: z.string().min(50),
  summary: z.string().max(500).optional(),
  cited_event_ids: z.array(z.string().uuid()).min(1),
  superseded: z
    .array(z.object({ old_event_id: z.string().uuid(), new_event_id: z.string().uuid() }))
    .default([]),
  contradictions: z
    .array(
      z.object({
        event_a_id: z.string().uuid(),
        event_b_id: z.string().uuid(),
        summary: z.string().min(10).max(500),
        resolution: z.string().max(1000),
      }),
    )
    .default([]),
});

const SYNTH_TOOL = {
  tools: [
    {
      toolSpec: {
        name: "emit_synthesis",
        description: "Emit the revised project narrative and knowledge maintenance marks.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              narrative_markdown: {
                type: "string",
                description:
                  "The full revised status narrative in markdown. Cite supporting events inline as [event:<id>].",
              },
              summary: {
                type: "string",
                description: "One-paragraph change summary, at most 500 characters.",
              },
              cited_event_ids: {
                type: "array",
                items: { type: "string", format: "uuid" },
                description:
                  "Every event id the narrative draws on — exact UUIDs from the provided event list only.",
              },
              superseded: {
                type: "array",
                description: "Older events whose claims are replaced by newer events.",
                items: {
                  type: "object",
                  properties: {
                    old_event_id: { type: "string" },
                    new_event_id: { type: "string" },
                  },
                  required: ["old_event_id", "new_event_id"],
                },
              },
              contradictions: {
                type: "array",
                description: "Pairs of events making conflicting claims that both remain plausible.",
                items: {
                  type: "object",
                  properties: {
                    event_a_id: { type: "string" },
                    event_b_id: { type: "string" },
                    summary: { type: "string" },
                    resolution: { type: "string", description: "Which claim the narrative follows, and why." },
                  },
                  required: ["event_a_id", "event_b_id", "summary", "resolution"],
                },
              },
            },
            required: ["narrative_markdown", "cited_event_ids"],
          },
        },
      },
    },
  ],
  toolChoice: { tool: { name: "emit_synthesis" } },
} as const;

const SYSTEM = `You maintain the status narrative for one engineering project in an org knowledge base. You receive the current narrative (possibly empty), the project's active typed events (each with an id), and open contradictions.

Rules:
- Rewrite the complete narrative: current status, recent decisions, blockers, deadlines, risks. Concise markdown, present tense, no invented facts — every claim must trace to an event.
- Cite events inline as [event:<uuid>] and list every used id in cited_event_ids. Use only exact UUIDs from the provided event list — never invent, truncate, or paraphrase ids.
- summary must be ≤500 characters.
- When a newer event replaces an older event's claim (e.g. a deadline moved again), record it in superseded — don't keep stale claims in the narrative.
- When two events conflict and both remain plausible, record a contradiction with your resolution, and follow the resolution in the narrative while noting the conflict.
- Confidence below 0.5 → hedge the claim ("reportedly", "unverified").
- Refer to people by name. Never include raw Slack user IDs.
- Do not open with a title heading, a status/priority echo line, or a horizontal rule — the app shows name and status in its own header. Start directly with the first section heading (e.g. "## Current Focus").`;

export async function synthesizeProject(
  deps: WorkerDeps,
  projectId: string,
): Promise<{ revision?: number; skipped?: string; superseded: number; contradictions: number }> {
  if (!deps.llm) throw new Error("llm not configured; cannot synthesize");

  const [project] = await deps.db
    .select()
    .from(tables.projects)
    .where(eq(tables.projects.id, projectId));
  if (!project) throw new Error(`synthesize: no project ${projectId}`);

  // Active events for the project, oldest first (the narrative's raw material).
  const events = await deps.db
    .select({
      id: tables.events.id,
      type: tables.events.type,
      title: tables.events.title,
      body: tables.events.body,
      confidence: tables.events.confidence,
      occurredAt: tables.events.occurredAt,
      extractedAt: tables.events.extractedAt,
    })
    .from(tables.events)
    .innerJoin(tables.eventProjects, eq(tables.eventProjects.eventId, tables.events.id))
    .where(
      and(eq(tables.eventProjects.projectId, projectId), eq(tables.events.status, "active")),
    )
    .orderBy(tables.events.extractedAt)
    .limit(200);
  if (events.length === 0) {
    return { skipped: "no active events", superseded: 0, contradictions: 0 };
  }

  // Narrative row (kind=status) + current revision; create the shell lazily.
  let [narrative] = await deps.db
    .select()
    .from(tables.narratives)
    .where(and(eq(tables.narratives.projectId, projectId), eq(tables.narratives.kind, "status")));
  if (!narrative) {
    [narrative] = await deps.db
      .insert(tables.narratives)
      .values({ projectId, kind: "status", title: `${project.name} — status` })
      .returning();
  }

  let currentBody = "";
  if (narrative!.currentRevisionId) {
    const [rev] = await deps.db
      .select()
      .from(tables.narrativeRevisions)
      .where(eq(tables.narrativeRevisions.id, narrative!.currentRevisionId));
    currentBody = rev?.body ?? "";
    // Debounce skip-guard: nothing new since the current revision.
    if (rev && !events.some((e) => e.extractedAt > rev.createdAt)) {
      return { skipped: "no new events since current revision", superseded: 0, contradictions: 0 };
    }
  }

  const openContradictions = await deps.db
    .select()
    .from(tables.contradictions)
    .where(
      and(
        eq(tables.contradictions.projectId, projectId),
        eq(tables.contradictions.status, "open"),
      ),
    );

  // Rejection feedback loop (task 4.7): what humans rejected on this project,
  // so rejected claims stay out of the regenerated narrative.
  const corrections = await synthesisCorrections(deps, projectId);

  const eventIds = new Set(events.map((e) => e.id));
  const prompt = `Project: ${project.name} (status: ${project.status}, priority: ${project.priority})

Current narrative:
${currentBody || "(none yet)"}

Active events (oldest first):
${events
  .map(
    (e) =>
      `- id=${e.id} [${e.type}] (confidence ${e.confidence}${e.occurredAt ? `, occurred ${e.occurredAt.toISOString().slice(0, 10)}` : ""}) ${e.title}${e.body ? ` — ${e.body.slice(0, 300)}` : ""}`,
  )
  .join("\n")}

Open contradictions:
${openContradictions.map((c) => `- ${c.summary}`).join("\n") || "(none)"}${corrections}`;

  const namePrompt = await slackRewriter(deps.db, [prompt]);
  const messages: Parameters<NonNullable<WorkerDeps["llm"]>["invoke"]>[1]["messages"] = [
    { role: "user", content: [{ text: namePrompt(prompt).slice(0, 100_000) }] },
  ];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await deps.llm.invoke("synthesizer", {
      system: SYSTEM,
      messages,
      toolConfig: SYNTH_TOOL as never,
      maxTokens: 25_000,
      temperature: 0.2,
      purpose: `synthesize:${project.slug}`,
    });

    const toolUse = response.message?.content?.find((b) => b.toolUse)?.toolUse;
    const parsed = synthesisSchema.safeParse(sanitizeSynthesisInput(toolUse?.input));
    // Drop foreign / unknown ids rather than failing the whole revision when
    // the model pads citations with junk; require at least one in-project cite.
    const out =
      parsed.success
        ? {
            ...parsed.data,
            cited_event_ids: parsed.data.cited_event_ids.filter((id) => eventIds.has(id)),
            superseded: parsed.data.superseded.filter(
              (s) => eventIds.has(s.old_event_id) && eventIds.has(s.new_event_id),
            ),
            contradictions: parsed.data.contradictions.filter(
              (c) => eventIds.has(c.event_a_id) && eventIds.has(c.event_b_id),
            ),
          }
        : null;
    const idsValid = !!out && out.cited_event_ids.length >= 1;

    if (parsed.success && idsValid && out) {
      const rewrite = await slackRewriter(deps.db, [
        out.narrative_markdown,
        out.summary ?? "",
        ...out.contradictions.flatMap((c) => [c.summary, c.resolution]),
      ]);

      // 1. Supersede marks: older claims leave current-state views.
      for (const s of out.superseded) {
        await deps.db
          .update(tables.events)
          .set({ status: "superseded", supersededById: s.new_event_id })
          .where(and(eq(tables.events.id, s.old_event_id), eq(tables.events.status, "active")));
      }

      // 2. Contradiction rows (skip pairs already recorded and open).
      let newContradictions = 0;
      for (const c of out.contradictions) {
        const pair = [c.event_a_id, c.event_b_id];
        const existing = openContradictions.find(
          (o) => pair.includes(o.eventAId) && pair.includes(o.eventBId),
        );
        if (existing) continue;
        await deps.db.insert(tables.contradictions).values({
          projectId,
          eventAId: c.event_a_id,
          eventBId: c.event_b_id,
          summary: rewrite(c.summary),
          resolution: rewrite(c.resolution),
        });
        newContradictions++;
      }

      // 3. The narrative revision itself, citations included (provenance chain).
      const supersededIds = new Set(out.superseded.map((s) => s.old_event_id));
      const { revision } = await createNarrativeRevision(deps.db, {
        narrativeId: narrative!.id,
        body: rewrite(out.narrative_markdown),
        summary: out.summary ? rewrite(out.summary) : undefined,
        citedEventIds: out.cited_event_ids.filter((id) => !supersededIds.has(id)),
        createdBy: `synthesizer:${response.modelId}`,
      });

      emitMetric("narrative_revisions", 1, { stage: "synthesize" });
      return { revision, superseded: out.superseded.length, contradictions: newContradictions };
    }

    const error = parsed.success
      ? "output references event ids that do not belong to this project"
      : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500);
    deps.logger.warn({ projectId, attempt, error }, "synthesis output failed validation");
    messages.push(
      { role: "assistant", content: response.message?.content ?? [{ text: response.text }] },
      retryFeedback(
        toolUse?.toolUseId,
        `Your emit_synthesis call failed validation: ${error}. Call emit_synthesis again with corrected input; only use event ids from the provided list.`,
      ),
    );
  }

  // No partial writes: narrative untouched, surfaced for operators.
  emitMetric("synthesis_failed", 1, { stage: "synthesize" });
  deps.logger.error({ projectId }, "synthesis failed validation twice; narrative unchanged");
  return { skipped: "validation failed twice", superseded: 0, contradictions: 0 };
}

/** Latest revision guard used by tests and future reject flows. */
export async function currentRevision(deps: WorkerDeps, narrativeId: string) {
  return (
    await deps.db
      .select()
      .from(tables.narrativeRevisions)
      .where(eq(tables.narrativeRevisions.narrativeId, narrativeId))
      .orderBy(desc(tables.narrativeRevisions.revision))
      .limit(1)
  )[0];
}

/** Enqueue debounced synthesis for the given projects (extractor + reject flows). */
export async function scheduleSynthesis(deps: WorkerDeps, projectIds: string[]): Promise<void> {
  const delaySeconds = Math.min(Number(process.env.SYNTHESIS_DEBOUNCE_S ?? 120), 900);
  const unique = [...new Set(projectIds)];
  if (unique.length === 0) return;
  await deps.enqueue(
    unique.map((projectId) => ({
      kind: "synthesize" as const,
      source: undefined,
      payload: { projectId },
      enqueuedAt: new Date().toISOString(),
    })),
    { delaySeconds },
  );
}
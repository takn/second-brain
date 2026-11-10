/**
 * Extractor agent (task 4.2): triaged-signal artifacts → schema-validated
 * typed events with confidence and source spans. One conversation, thread, or
 * transcript per invocation (batch-by-conversation, design D2). Invalid model
 * output is retried once with validation feedback, then the artifact is
 * parked for manual review — never partial writes (brain-agents spec).
 *
 * Also task 4.3: extracted action items are matched against the work-item
 * mirror (explicit Jira keys / tracker URLs); misses become untracked_work.
 */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { and, eq, sql as dsql } from "drizzle-orm";
import { createEvent, EVENT_TYPES, tables } from "@second-brain/schema";
import { z } from "zod";
import { extractionCorrections } from "./lib/corrections.ts";
import type { WorkerDeps } from "./lib/deps.ts";
import { retryFeedback } from "./lib/llm.ts";
import { emitMetric } from "./lib/metrics.ts";
import { formatSlackMessagesForLlm, slackRewriter } from "./lib/slack-people.ts";
import type { RawEnvelope } from "./raw.ts";
import { scheduleSynthesis } from "./synthesizer.ts";
import type { NormalizedTranscript } from "./connectors/transcripts.ts";

const extractedEventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  title: z.string().min(8).max(300),
  body: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1),
  /** Source span: message ts values or transcript segment indexes. */
  span: z.object({ from: z.string(), to: z.string() }),
  project_slugs: z.array(z.string()).min(1),
});

const extractionSchema = z.object({ events: z.array(extractedEventSchema).max(20) });

const EXTRACT_TOOL = {
  tools: [
    {
      toolSpec: {
        name: "emit_events",
        description: "Emit the typed events extracted from the conversation.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              events: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: [...EVENT_TYPES] },
                    title: { type: "string", description: "The claim, one specific sentence." },
                    body: { type: "string", description: "Supporting context, optional." },
                    confidence: { type: "number", description: "0..1" },
                    span: {
                      type: "object",
                      properties: {
                        from: { type: "string", description: "first source ref (ts or segment #)" },
                        to: { type: "string", description: "last source ref" },
                      },
                      required: ["from", "to"],
                    },
                    project_slugs: {
                      type: "array",
                      items: { type: "string" },
                      description: "one or more project slugs from the provided list",
                    },
                  },
                  required: ["type", "title", "confidence", "span", "project_slugs"],
                },
              },
            },
            required: ["events"],
          },
        },
      },
    },
  ],
  toolChoice: { tool: { name: "emit_events" } },
} as const;

function systemPrompt(projects: { slug: string; name: string }[], corrections: string): string {
  return `You extract typed events from workplace conversations for an engineering org's knowledge base. Event types: ${EVENT_TYPES.join(", ")}.

Rules:
- Extract only claims actually made in the conversation; never infer beyond the text.
- Each event links to one or more projects from this list (slug — name):
${projects.map((p) => `  ${p.slug} — ${p.name}`).join("\n")}
- If nothing project-relevant was said, emit an empty events array.
- span.from/span.to are the source refs (message ts or segment number) bracketing the claim.
- confidence reflects how explicit the claim is (direct statement ≈ 0.9+, implication ≈ 0.5).
- For action_item events, keep any issue references (INFRA-123, #45, URLs) verbatim in the title or body.
- Refer to people by the names in the transcript. Never write Slack user IDs.${corrections}`;
}

/** Render the artifact as numbered source lines the model can span-reference. */
async function conversationText(
  deps: WorkerDeps,
  row: { objectKey: string; normalizedObjectKey: string | null },
  envelope: RawEnvelope,
): Promise<string | null> {
  if (envelope.source === "slack") {
    const payload = envelope.payload as {
      channelId?: string;
      messages?: { ts: string; user?: string; bot_id?: string; text?: string }[];
    };
    if (!payload.messages?.length) return null;
    const meta = envelope.sourceMeta as { channelName?: string };
    const thread = await formatSlackMessagesForLlm(deps, payload.messages, { withTs: true });
    return `Slack #${meta.channelName ?? payload.channelId}:\n${thread}`.slice(0, 24_000);
  }
  if (envelope.source === "gws" && row.normalizedObjectKey) {
    const obj = await deps.s3.send(
      new GetObjectCommand({ Bucket: deps.bucket, Key: row.normalizedObjectKey }),
    );
    const transcript = JSON.parse((await obj.Body!.transformToString()) ?? "{}") as
      NormalizedTranscript;
    return `Meeting transcript:\n${transcript.segments
      .map(
        (s, i) =>
          `[${i}] ${s.speaker ?? "unknown"}${s.attributionConfirmed ? "" : " (attribution uncertain)"}: ${s.text}`,
      )
      .join("\n")}`.slice(0, 24_000);
  }
  return null;
}

/** Task 4.3: explicit tracker references → work item link; miss → untracked_work. */
async function matchWorkItem(
  deps: WorkerDeps,
  eventId: string,
  projectId: string,
  text: string,
): Promise<void> {
  const jiraKey = text.match(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/)?.[1];
  if (jiraKey) {
    const [item] = await deps.db
      .select({ id: tables.workItems.id })
      .from(tables.workItems)
      .where(and(eq(tables.workItems.source, "jira"), eq(tables.workItems.sourceId, jiraKey)));
    if (item) {
      await deps.db
        .update(tables.events)
        .set({ workItemId: item.id })
        .where(eq(tables.events.id, eventId));
      return;
    }
  }
  const urlMatch = text.match(/https:\/\/gitlab\.com\/\S+\/-\/(?:issues|work_items)\/(\d+)/);
  if (urlMatch) {
    const [item] = await deps.db
      .select({ id: tables.workItems.id })
      .from(tables.workItems)
      .where(dsql`${tables.workItems.webUrl} like ${`%/${urlMatch[1]}`}`)
      .limit(1);
    if (item) {
      await deps.db
        .update(tables.events)
        .set({ workItemId: item.id })
        .where(eq(tables.events.id, eventId));
      return;
    }
  }

  // No mirrored work item → untracked work (domain-model spec).
  const [event] = await deps.db.select().from(tables.events).where(eq(tables.events.id, eventId));
  await deps.db
    .insert(tables.untrackedWork)
    .values({ eventId, projectId, title: event!.title })
    .onConflictDoNothing({ target: tables.untrackedWork.eventId });
}

export async function extractArtifact(
  deps: WorkerDeps,
  row: { id: string; sourceKey: string; objectKey: string; normalizedObjectKey: string | null },
  envelope: RawEnvelope,
): Promise<{ events: number; parked: boolean }> {
  if (!deps.llm) throw new Error("llm not configured; cannot extract");

  const text = await conversationText(deps, row, envelope);
  if (!text) {
    deps.logger.info({ sourceKey: row.sourceKey }, "nothing extractable in artifact; acknowledging");
    return { events: 0, parked: false };
  }

  const projects = await deps.db
    .select({
      id: tables.projects.id,
      slug: tables.projects.slug,
      name: tables.projects.name,
    })
    .from(tables.projects);
  const slugToId = new Map(projects.map((p) => [p.slug, p.id]));

  // Rejection feedback loop (task 4.7): human rejections become few-shot
  // correction examples, similar sources first.
  const corrections = await extractionCorrections(deps, envelope.source);

  const messages: Parameters<NonNullable<WorkerDeps["llm"]>["invoke"]>[1]["messages"] = [
    { role: "user", content: [{ text }] },
  ];

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await deps.llm.invoke("extractor", {
      system: systemPrompt(projects, corrections),
      messages,
      toolConfig: EXTRACT_TOOL as never,
      maxTokens: 3000,
      temperature: 0,
      purpose: row.sourceKey,
    });

    const toolUse = response.message?.content?.find((b) => b.toolUse)?.toolUse;
    const parsed = extractionSchema.safeParse(toolUse?.input);

    if (parsed.success) {
      // Drop events whose slugs don't resolve; an event needs ≥1 real project.
      const rewrite = await slackRewriter(
        deps.db,
        parsed.data.events.flatMap((ev) => [ev.title, ev.body ?? ""]),
      );
      let created = 0;
      const touchedProjects = new Set<string>();
      for (const [i, ev] of parsed.data.events.entries()) {
        const projectIds = ev.project_slugs
          .map((s) => slugToId.get(s))
          .filter((id): id is string => Boolean(id));
        if (projectIds.length === 0) continue;
        const { eventId, created: isNew } = await createEvent(deps.db, {
          type: ev.type,
          title: rewrite(ev.title),
          body: ev.body ? rewrite(ev.body) : undefined,
          confidence: ev.confidence,
          artifactId: row.id,
          projectIds,
          span: ev.span,
          permalink: (envelope.sourceMeta as { permalink?: string }).permalink,
          extractedBy: `extractor:${response.modelId}`,
          dedupeKey: `extract:${row.sourceKey}:${i}`,
        });
        if (isNew) {
          created++;
          for (const id of projectIds) touchedProjects.add(id);
          if (ev.type === "action_item") {
            await matchWorkItem(
              deps,
              eventId,
              projectIds[0]!,
              `${rewrite(ev.title)} ${ev.body ? rewrite(ev.body) : ""}`,
            );
          }
        }
      }
      emitMetric("events_extracted", created, { stage: "extract", source: envelope.source });
      // New knowledge → debounced narrative regeneration (task 4.4 trigger).
      await scheduleSynthesis(deps, [...touchedProjects]);
      return { events: created, parked: false };
    }

    lastError = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")
      .slice(0, 500);
    deps.logger.warn(
      { sourceKey: row.sourceKey, attempt, error: lastError },
      "extraction output failed validation",
    );
    // Retry with feedback (spec: retry with feedback, then park).
    messages.push(
      { role: "assistant", content: response.message?.content ?? [{ text: response.text }] },
      retryFeedback(
        toolUse?.toolUseId,
        `Your emit_events call failed validation: ${lastError}. Call emit_events again with corrected, schema-valid input.`,
      ),
    );
  }

  await deps.db
    .insert(tables.parkedArtifacts)
    .values({ artifactId: row.id, stage: "extract", reason: lastError, attempts: 2 })
    .onConflictDoNothing({ target: tables.parkedArtifacts.artifactId });
  emitMetric("parked", 1, { stage: "extract", source: envelope.source });
  deps.logger.error({ sourceKey: row.sourceKey, lastError }, "extraction parked for manual review");
  return { events: 0, parked: true };
}

import { randomUUID } from "node:crypto";
import { applyMigrations, createEvent, tables } from "@second-brain/schema";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractArtifact } from "../extractor.ts";
import { synthesizeProject } from "../synthesizer.ts";
import { extractionCorrections, synthesisCorrections } from "./corrections.ts";
import { createS3Client, type WorkerDeps } from "./deps.ts";
import type { Llm, LlmRequest, LlmResponse } from "./llm.ts";

const dbUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://brain:brain@localhost:54321/brain";

process.env.AWS_ACCESS_KEY_ID ??= "brainlocal";
process.env.AWS_SECRET_ACCESS_KEY ??= "brainlocal";

const probe = postgres(dbUrl, { max: 1, connect_timeout: 3 });
let stackUp = false;
try {
  await probe`select 1`;
  stackUp = true;
} catch {
  // leave stackUp false
} finally {
  await probe.end();
}

describe.skipIf(!stackUp)("rejection feedback loop", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  let projectId: string;
  let personId: string;
  let gwsArtifactId: string;
  let transcriptArtifactId: string;

  function makeDeps(llm?: Llm): WorkerDeps {
    return {
      db,
      s3: createS3Client({
        S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000",
        S3_REGION: "us-east-1",
      } as NodeJS.ProcessEnv),
      bucket: process.env.S3_BUCKET_RAW ?? "second-brain-raw",
      enqueue: () => {},
      logger: pino({ level: "silent" }),
      llm,
    };
  }

  /** Llm stub that records every request and returns a fixed tool-use input. */
  function capturingLlm(input: unknown): { llm: Llm; requests: LlmRequest[] } {
    const requests: LlmRequest[] = [];
    const llm = {
      invoke: async (_agent: string, request: LlmRequest) => {
        requests.push(request);
        return {
          text: "",
          message: { role: "assistant", content: [{ toolUse: { name: "tool", input } }] },
          stopReason: "tool_use",
          usage: { inputTokens: 100, outputTokens: 100 },
          costUsd: 0.005,
          modelId: "fake",
        } as unknown as LlmResponse;
      },
      spentTodayUsd: async () => 0,
      config: {} as Llm["config"],
    } as unknown as Llm;
    return { llm, requests };
  }

  async function makeRejectedEvent(input: {
    artifactId: string;
    title: string;
    reason: string;
  }): Promise<void> {
    const { eventId } = await createEvent(db, {
      type: "decision",
      title: input.title,
      confidence: 0.9,
      artifactId: input.artifactId,
      projectIds: [projectId],
    });
    await db
      .update(tables.events)
      .set({ status: "rejected" })
      .where(eq(tables.events.id, eventId));
    const [event] = await db
      .select()
      .from(tables.events)
      .where(eq(tables.events.id, eventId));
    await db.insert(tables.rejections).values({
      targetKind: "event",
      targetId: eventId,
      projectId,
      rejectedById: personId,
      reason: input.reason,
      snapshot: event!,
    });
  }

  beforeAll(async () => {
    await applyMigrations(sql);
    // The extraction-corrections query is global; retire rows from previous
    // runs of THIS suite so ranking assertions stay deterministic. (gws and
    // transcript sources are used by no other suite's rejections.)
    await db
      .delete(tables.rejections)
      .where(
        inArray(tables.rejections.reason, [
          "meeting attribution was wrong",
          "sarcasm read as a decision",
        ]),
      );
    const [project] = await db
      .insert(tables.projects)
      .values({ slug: `fb-${randomUUID().slice(0, 8)}`, name: "Feedback Test Project" })
      .returning();
    projectId = project!.id;
    const [person] = await db
      .insert(tables.people)
      .values({ displayName: "Feedback Tester", email: `fb-${randomUUID().slice(0, 8)}@test` })
      .returning();
    personId = person!.id;
    const [gwsArt] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "gws", sourceKey: `fb:gws:${randomUUID()}`, objectKey: "raw/fb1.json" })
      .returning();
    gwsArtifactId = gwsArt!.id;
    const [transcriptArt] = await db
      .insert(tables.rawArtifacts)
      .values({
        source: "transcript",
        sourceKey: `fb:transcript:${randomUUID()}`,
        objectKey: "raw/fb2.json",
      })
      .returning();
    transcriptArtifactId = transcriptArt!.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("formats extraction corrections, similar source first", async () => {
    // Insert the same-source example FIRST so recency alone would rank it
    // last — the pass below only holds if source affinity outranks recency.
    await makeRejectedEvent({
      artifactId: gwsArtifactId,
      title: "Gws-sourced hallucination",
      reason: "meeting attribution was wrong",
    });
    await makeRejectedEvent({
      artifactId: transcriptArtifactId,
      title: "Transcript-sourced hallucination",
      reason: "sarcasm read as a decision",
    });

    const block = await extractionCorrections(makeDeps(), "gws");
    expect(block).toContain("do not repeat these mistakes");
    expect(block).toContain("meeting attribution was wrong");
    expect(block).toContain("sarcasm read as a decision");
    // Same-source example ranks first despite being older.
    expect(block.indexOf("Gws-sourced hallucination")).toBeLessThan(
      block.indexOf("Transcript-sourced hallucination"),
    );
  });

  it("formats synthesis corrections for the project only", async () => {
    await db.insert(tables.rejections).values({
      targetKind: "narrative_revision",
      targetId: randomUUID(),
      projectId,
      rejectedById: personId,
      reason: "overstated the launch readiness",
      snapshot: { revision: 3, summary: "Launch is ready" },
    });

    const block = await synthesisCorrections(makeDeps(), projectId);
    expect(block).toContain("Do not reintroduce rejected claims");
    expect(block).toContain("rejected narrative revision r3");
    expect(block).toContain("overstated the launch readiness");
    expect(block).toContain("sarcasm read as a decision"); // event rejection, same project

    const other = await synthesisCorrections(makeDeps(), randomUUID());
    expect(other).toBe("");
  });

  it("injects corrections into the extractor system prompt", async () => {
    const { llm, requests } = capturingLlm({ events: [] });
    const [artifact] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "slack", sourceKey: `fb:x:${randomUUID()}`, objectKey: "raw/fb3.json" })
      .returning();
    await extractArtifact(
      makeDeps(llm),
      { ...artifact!, normalizedObjectKey: null },
      {
        source: "slack",
        sourceKey: artifact!.sourceKey,
        collectedAt: new Date().toISOString(),
        sourceMeta: {},
        payload: { channelId: "C1", messages: [{ ts: "1", user: "U1", text: "hello world" }] },
      },
    );
    expect(requests).toHaveLength(1);
    // The specific examples shown depend on what else lives in the shared
    // dev DB; the block header proves the loop is wired into the prompt.
    expect(requests[0]!.system).toContain("Previously rejected extractions");
    expect(requests[0]!.system).toContain("rejected:");
  });

  it("injects corrections into the synthesizer prompt", async () => {
    const { eventId } = await createEvent(db, {
      type: "status_change",
      title: "Feedback project is on track",
      confidence: 0.9,
      artifactId: gwsArtifactId,
      projectIds: [projectId],
    });
    const { llm, requests } = capturingLlm({
      narrative_markdown: `## Status\nOn track [event:${eventId}] and moving along nicely.`,
      cited_event_ids: [eventId],
    });
    const result = await synthesizeProject(makeDeps(llm), projectId);
    expect(result.revision).toBe(1);
    const promptText = (requests[0]!.messages[0]!.content?.[0] as { text: string }).text;
    expect(promptText).toContain("Human rejections on this project");
    expect(promptText).toContain("overstated the launch readiness");
  });
});

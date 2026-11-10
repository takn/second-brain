import { randomUUID } from "node:crypto";
import { applyMigrations, createEvent, tables } from "@second-brain/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Client, type WorkerDeps } from "./lib/deps.ts";
import type { Llm, LlmRequest, LlmResponse } from "./lib/llm.ts";
import { answerQuery, failStalePendingQueries } from "./query.ts";

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

describe.skipIf(!stackUp)("query agent", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  const run = randomUUID().slice(0, 8);
  let projectSlug: string;
  let personId: string;
  let blockerEventId: string;

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

  /**
   * Scripted llm: each turn returns the next tool call(s); records requests.
   * A step may return one call or an array (models can call tools in parallel).
   */
  function scriptedLlm(
    script: ((
      requests: LlmRequest[],
    ) => { name: string; input: unknown } | { name: string; input: unknown }[])[],
  ): { llm: Llm; requests: LlmRequest[] } {
    const requests: LlmRequest[] = [];
    const llm = {
      invoke: async (_agent: string, request: LlmRequest) => {
        requests.push(request);
        const step = script[Math.min(requests.length - 1, script.length - 1)]!;
        const calls = [step(requests)].flat();
        return {
          text: "",
          message: {
            role: "assistant",
            content: calls.map((c, i) => ({
              toolUse: { toolUseId: `tu-${requests.length}-${i}`, name: c.name, input: c.input },
            })),
          },
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

  /**
   * All toolResult blocks in conversation order. The agent mutates one shared
   * messages array, so requests hold aliases — only the final state matters.
   */
  function toolResults(
    requests: LlmRequest[],
  ): { status?: string; content?: { text?: string }[] }[] {
    return requests
      .at(-1)!
      .messages.flatMap((m) => m.content ?? [])
      .flatMap((b) => ((b as { toolResult?: object }).toolResult ? [(b as never)["toolResult"]] : []));
  }

  async function makeQuery(question: string): Promise<string> {
    const [q] = await db
      .insert(tables.brainQueries)
      .values({ question, askedById: personId })
      .returning({ id: tables.brainQueries.id });
    return q!.id;
  }

  beforeAll(async () => {
    await applyMigrations(sql);
    const [person] = await db
      .insert(tables.people)
      .values({ displayName: "Asker", email: `ask-${run}@test` })
      .returning();
    personId = person!.id;

    projectSlug = `qry-gadget-${run}`;
    const [project] = await db
      .insert(tables.projects)
      .values({ slug: projectSlug, name: `Query Gadget ${run}` })
      .returning();
    const [artifact] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "slack", sourceKey: `qry:${randomUUID()}`, objectKey: "raw/qry.json" })
      .returning();
    ({ eventId: blockerEventId } = await createEvent(db, {
      type: "blocker_raised",
      title: `Gadget ${run} release blocked on flaky integration tests`,
      confidence: 0.9,
      artifactId: artifact!.id,
      projectIds: [project!.id],
    }));
  });

  afterAll(async () => {
    await sql.end();
  });

  it("searches, drills down, and answers with valid citations", async () => {
    const queryId = await makeQuery(`What is blocking the Gadget ${run} release?`);
    const { llm, requests } = scriptedLlm([
      () => ({ name: "search_brain", input: { query: `Gadget ${run} release` } }),
      () => ({ name: "project_status", input: { slug: projectSlug } }),
      () => ({
        name: "emit_answer",
        input: {
          answer_markdown: `The release is blocked on flaky integration tests [event:${blockerEventId}].`,
          cited_event_ids: [blockerEventId],
        },
      }),
    ]);

    const result = await answerQuery(makeDeps(llm), queryId);
    expect(result).toEqual({ status: "answered", turns: 3 });

    // The search tool result carried the blocker event id back to the model,
    // and the drill-down result carried the structured project shape.
    const results = toolResults(requests);
    expect(results[0]!.content![0]!.text).toContain(blockerEventId);
    expect(results[1]!.content![0]!.text).toContain("blocker_and_deadline_events");

    const [row] = await db
      .select()
      .from(tables.brainQueries)
      .where(eq(tables.brainQueries.id, queryId));
    expect(row!.status).toBe("answered");
    expect(row!.answer).toContain("flaky integration tests");
    expect(row!.citedEventIds).toEqual([blockerEventId]);
    expect(row!.answeredBy).toBe("query:fake");
    expect(row!.answeredAt).not.toBeNull();
  });

  it("rejects citations the model never saw, accepts the corrected retry", async () => {
    const queryId = await makeQuery("What is the release status?");
    const bogusId = randomUUID();
    const { llm, requests } = scriptedLlm([
      () => ({ name: "search_brain", input: { query: `Gadget ${run}` } }),
      () => ({
        name: "emit_answer",
        input: { answer_markdown: "Blocked on something, definitely.", cited_event_ids: [bogusId] },
      }),
      () => ({
        name: "emit_answer",
        input: {
          answer_markdown: "The release is blocked on flaky integration tests, per the team.",
          cited_event_ids: [blockerEventId],
        },
      }),
    ]);

    const result = await answerQuery(makeDeps(llm), queryId);
    expect(result.status).toBe("answered");

    // The failed emit_answer got error tool_result feedback.
    const feedback = toolResults(requests).find((tr) => tr.status === "error");
    expect(feedback).toBeDefined();
    expect(feedback!.content![0]!.text).toContain("did not appear in any tool result");
  });

  it("answers every tool call when the model calls tools in parallel", async () => {
    const queryId = await makeQuery("Parallel searches?");
    const { llm, requests } = scriptedLlm([
      () => [
        { name: "search_brain", input: { query: `Gadget ${run}` } },
        { name: "search_brain", input: { query: "release blockers" } },
      ],
      () => ({
        name: "emit_answer",
        input: {
          answer_markdown: "Blocked on flaky integration tests, per the project channel.",
          cited_event_ids: [blockerEventId],
        },
      }),
    ]);

    const result = await answerQuery(makeDeps(llm), queryId);
    expect(result.status).toBe("answered");

    // The reply to the parallel turn carries one toolResult per toolUse id —
    // Bedrock rejects the conversation otherwise (seen live in production).
    const replyBlocks = requests[1]!.messages[2]!.content as {
      toolResult?: { toolUseId: string };
    }[];
    const ids = replyBlocks.map((b) => b.toolResult?.toolUseId);
    expect(ids).toEqual(["tu-1-0", "tu-1-1"]);
  });

  it("marks the query failed after repeated invalid answers", async () => {
    const queryId = await makeQuery("Unanswerable?");
    const bad = () => ({
      name: "emit_answer",
      input: { answer_markdown: "Citing ghosts for a long enough answer here.", cited_event_ids: [randomUUID()] },
    });
    const { llm } = scriptedLlm([bad, bad, bad]);

    const result = await answerQuery(makeDeps(llm), queryId);
    expect(result.status).toBe("failed");

    const [row] = await db
      .select()
      .from(tables.brainQueries)
      .where(eq(tables.brainQueries.id, queryId));
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("failed validation twice");
    expect(row!.answer).toBeNull();
  });

  it("sweeps stale pending queries to failed, leaving fresh ones alone", async () => {
    const staleId = await makeQuery("Stale question whose job died");
    await db
      .update(tables.brainQueries)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(tables.brainQueries.id, staleId));
    const freshId = await makeQuery("Fresh question still in flight");

    const swept = await failStalePendingQueries(makeDeps(), 15 * 60_000);
    expect(swept).toBeGreaterThanOrEqual(1);

    const [stale] = await db
      .select({ status: tables.brainQueries.status, error: tables.brainQueries.error })
      .from(tables.brainQueries)
      .where(eq(tables.brainQueries.id, staleId));
    expect(stale!.status).toBe("failed");
    expect(stale!.error).toContain("ask again");

    const [fresh] = await db
      .select({ status: tables.brainQueries.status })
      .from(tables.brainQueries)
      .where(eq(tables.brainQueries.id, freshId));
    expect(fresh!.status).toBe("pending");
  });

  it("forces emit_answer on the final turn and fails cleanly when exhausted", async () => {
    const queryId = await makeQuery("Spin forever?");
    const { llm, requests } = scriptedLlm([
      () => ({ name: "search_brain", input: { query: "nothing relevant here" } }),
    ]);

    const result = await answerQuery(makeDeps(llm), queryId);
    expect(result.status).toBe("failed");
    // Final turn pinned the tool choice to emit_answer.
    const lastToolConfig = requests.at(-1)!.toolConfig as {
      toolChoice?: { tool?: { name?: string } };
    };
    expect(lastToolConfig.toolChoice?.tool?.name).toBe("emit_answer");

    const [row] = await db
      .select({ status: tables.brainQueries.status })
      .from(tables.brainQueries)
      .where(eq(tables.brainQueries.id, queryId));
    expect(row!.status).toBe("failed");
  });
});

import { randomUUID } from "node:crypto";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { applyMigrations, tables, type Job } from "@second-brain/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handlers } from "./funnel.ts";
import { createS3Client, type WorkerDeps } from "./lib/deps.ts";
import type { Llm } from "./lib/llm.ts";
import { putRawArtifact } from "./raw.ts";
import { heuristicTriage, triageArtifact } from "./triage.ts";

const dbUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://brain:brain@localhost:54321/brain";
const s3Env = {
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000",
  S3_REGION: "us-east-1",
} as NodeJS.ProcessEnv;
const bucket = process.env.S3_BUCKET_RAW ?? "second-brain-raw";

process.env.AWS_ACCESS_KEY_ID ??= "brainlocal";
process.env.AWS_SECRET_ACCESS_KEY ??= "brainlocal";

const probe = postgres(dbUrl, { max: 1, connect_timeout: 3 });
let stackUp = false;
try {
  await probe`select 1`;
  const s3 = createS3Client(s3Env);
  await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch((err) => {
    if (err.name !== "BucketAlreadyOwnedByYou" && err.name !== "BucketAlreadyExists") throw err;
  });
  stackUp = true;
} catch {
  // leave stackUp false
} finally {
  await probe.end();
}

const msg = (text: string, over: Record<string, unknown> = {}) => ({
  ts: `${Date.now() / 1000}`,
  user: "U1",
  text,
  ...over,
});

describe("triage heuristics (pure)", () => {
  it("marks bot-only threads as noise without a model call", () => {
    const d = heuristicTriage([msg("collected by second-brain", { user: undefined, bot_id: "B1" })]);
    expect(d).toMatchObject({ verdict: "noise", method: "heuristic-noise" });
  });

  it("marks trivial one-liners as noise", () => {
    expect(heuristicTriage([msg("thanks! 🎉")])).toMatchObject({ verdict: "noise" });
  });

  it("marks keyword threads as signal", () => {
    const d = heuristicTriage([msg("heads up, the Sep 30 deadline slipped to Oct 7")]);
    expect(d).toMatchObject({ verdict: "signal", method: "heuristic-signal" });
  });

  it("returns null for ambiguous threads (model decides)", () => {
    expect(
      heuristicTriage([msg("did you see the new cluster dashboards?"), msg("yeah, looking now")]),
    ).toBeNull();
  });
});

describe.skipIf(!stackUp)("triage stage (integration)", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  const queued: Job[] = [];

  function fakeLlm(reply: string): {
    llm: Llm;
    invocations: number[];
    prompts: string[];
  } {
    const invocations: number[] = [];
    const prompts: string[] = [];
    const llm = {
      invoke: async (_agent: string, req: { messages: { content: { text?: string }[] }[] }) => {
        invocations.push(1);
        const text = req.messages[0]?.content.find((c) => c.text)?.text ?? "";
        prompts.push(text);
        return {
          text: reply,
          message: undefined,
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 10 },
          costUsd: 0.0001,
          modelId: "fake",
        };
      },
      spentTodayUsd: async () => 0,
      config: {} as Llm["config"],
    } as unknown as Llm;
    return { llm, invocations, prompts };
  }

  function makeDeps(llm?: Llm): WorkerDeps {
    return {
      db,
      s3: createS3Client(s3Env),
      bucket,
      enqueue: (jobs) => {
        queued.push(...jobs);
      },
      logger: pino({ level: "silent" }),
      llm,
    };
  }

  async function slackArtifact(deps: WorkerDeps, messages: unknown[]) {
    const sourceKey = `T1:C1:${randomUUID()}`;
    const { artifactId } = await putRawArtifact(deps, {
      source: "slack",
      sourceKey,
      payload: { teamId: "T1", channelId: "C1", threadTs: "1", messages },
      sourceMeta: { channelName: "eng-general" },
    });
    return { artifactId, sourceKey };
  }

  beforeAll(async () => {
    await applyMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  it("thresholds model scores and records the decision", async () => {
    const { llm, invocations } = fakeLlm(
      '{"signal": false, "confidence": 0.8, "event_types": [], "topics": ["chitchat"]}',
    );
    const deps = makeDeps(llm);
    const { artifactId, sourceKey } = await slackArtifact(deps, [
      msg("did you see the new cluster dashboards?"),
      msg("yeah, looking now"),
    ]);

    const envelope = {
      source: "slack" as const,
      sourceKey,
      collectedAt: new Date().toISOString(),
      sourceMeta: { channelName: "eng-general" },
      payload: {
        channelId: "C1",
        messages: [msg("did you see the new dashboards?"), msg("yeah, looking now")],
      },
    };
    const decision = await triageArtifact(deps, artifactId, sourceKey, envelope);

    expect(invocations).toHaveLength(1);
    // signal:false at 0.8 confidence → P(signal)=0.2 → below 0.5 → noise
    expect(decision).toMatchObject({ verdict: "noise", method: "model" });
    expect(decision.score).toBeCloseTo(0.2);

    const [row] = await db
      .select()
      .from(tables.triageDecisions)
      .where(eq(tables.triageDecisions.sourceKey, sourceKey));
    expect(row).toMatchObject({ verdict: "noise", method: "model", threshold: 0.5 });
    expect((row!.tags as { topics: string[] }).topics).toEqual(["chitchat"]);
  });

  it("passes confident signal through to extract via the funnel handler", async () => {
    const { llm } = fakeLlm(
      '{"signal": true, "confidence": 0.9, "event_types": ["decision"], "topics": ["infra"]}',
    );
    const deps = makeDeps(llm);
    const { sourceKey } = await slackArtifact(deps, [
      msg("so are we going with option B?"),
      msg("yes, option B, kicking off tomorrow", { user: "U2" }),
    ]);

    queued.length = 0;
    await handlers.triage(deps, {
      kind: "triage",
      source: "slack",
      sourceKey,
      payload: {},
      enqueuedAt: new Date().toISOString(),
    });
    expect(queued.map((j) => j.kind)).toEqual(["extract"]);
    expect((queued[0]!.payload.triage as { score: number }).score).toBeCloseTo(0.9);
  });

  it("stops noise at triage: no extract job", async () => {
    const deps = makeDeps(); // heuristics only; bot thread never reaches the model
    const { sourceKey } = await slackArtifact(deps, [
      msg("channel collected notice", { user: undefined, bot_id: "B7" }),
    ]);

    queued.length = 0;
    await handlers.triage(deps, {
      kind: "triage",
      source: "slack",
      sourceKey,
      payload: {},
      enqueuedAt: new Date().toISOString(),
    });
    expect(queued).toHaveLength(0);

    const [row] = await db
      .select()
      .from(tables.triageDecisions)
      .where(eq(tables.triageDecisions.sourceKey, sourceKey));
    expect(row!.verdict).toBe("noise");
  });

  it("fails open to signal when no model is configured", async () => {
    const deps = makeDeps(); // no llm
    const { artifactId, sourceKey } = await slackArtifact(deps, [
      msg("ambiguous chatter one"),
      msg("ambiguous chatter two"),
    ]);
    const decision = await triageArtifact(deps, artifactId, sourceKey, {
      source: "slack",
      sourceKey,
      collectedAt: new Date().toISOString(),
      sourceMeta: {},
      payload: { channelId: "C1", messages: [msg("hmm okay then"), msg("sure, sounds fine")] },
    });
    expect(decision).toMatchObject({ verdict: "signal", method: "fallback-no-llm" });
  });

  it("resolves linked Slack users to display names in the model prompt", async () => {
    const run = randomUUID().slice(0, 8);
    const slackId = `UTRI${run}`;
    await db.insert(tables.people).values({
      displayName: `Triage Person ${run}`,
      email: `triage-${run}@example.com`,
      slackUserId: slackId,
    });

    const { llm, prompts } = fakeLlm(
      '{"signal": true, "confidence": 0.7, "event_types": [], "topics": ["dash"]}',
    );
    const deps = makeDeps(llm);
    const messages = [
      msg("did you see the new cluster dashboards?", { user: slackId }),
      msg(`cc <@${slackId}> looking now`, { user: "U2" }),
    ];
    const { artifactId, sourceKey } = await slackArtifact(deps, messages);
    await triageArtifact(deps, artifactId, sourceKey, {
      source: "slack",
      sourceKey,
      collectedAt: new Date().toISOString(),
      sourceMeta: { channelName: "eng-general" },
      payload: { channelId: "C1", messages },
    });

    expect(prompts[0]).toContain(`Triage Person ${run}:`);
    expect(prompts[0]).toContain(`@Triage Person ${run}`);
    expect(prompts[0]).not.toContain(`<@${slackId}>`);
  });
});

import { randomUUID } from "node:crypto";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { applyMigrations, jobSchema, tables, type Job } from "@second-brain/schema";
import { eq, gte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handlers, recordSyncRun } from "./funnel.ts";
import { createEnqueue, createS3Client, createSqsClient, type WorkerDeps } from "./lib/deps.ts";
import { getRawArtifact, putRawArtifact } from "./raw.ts";

const dbUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://brain:brain@localhost:54321/brain";
const s3Env = {
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000",
  S3_REGION: "us-east-1",
} as NodeJS.ProcessEnv;
const sqsEnv = {
  SQS_ENDPOINT: process.env.TEST_SQS_ENDPOINT ?? "http://localhost:9324",
  S3_REGION: "us-east-1",
} as NodeJS.ProcessEnv;
const bucket = process.env.S3_BUCKET_RAW ?? "second-brain-raw";
const queueName = "brain-jobs-test";

process.env.AWS_ACCESS_KEY_ID ??= "brainlocal";
process.env.AWS_SECRET_ACCESS_KEY ??= "brainlocal";

// Integration suite: needs the local stack (postgres, minio, elasticmq) or CI
// services. Skips silently when any piece is unreachable.
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

describe.skipIf(!stackUp)("raw layer and funnel", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  const s3 = createS3Client(s3Env);
  const sqs = createSqsClient(sqsEnv);
  let queueUrl: string;

  const queued: Job[] = [];
  const deps: WorkerDeps = {
    db,
    s3,
    bucket,
    enqueue: (jobs) => {
      queued.push(...jobs);
    },
    logger: pino({ level: "silent" }),
    // minimal extractor stub: valid tool call, zero events
    llm: {
      invoke: async () => ({
        text: "",
        message: {
          role: "assistant",
          content: [{ toolUse: { name: "emit_events", input: { events: [] } } }],
        },
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
        modelId: "fake",
      }),
      spentTodayUsd: async () => 0,
      config: {},
    } as unknown as WorkerDeps["llm"],
  };

  beforeAll(async () => {
    await applyMigrations(sql);
    const created = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
    queueUrl = created.QueueUrl!;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("stores raw artifacts immutably with metadata, idempotent on sourceKey", async () => {
    const sourceKey = `C42:${randomUUID()}`;
    const input = {
      source: "slack" as const,
      sourceKey,
      payload: { text: "we decided to ship tuesday", ts: "1725.001" },
      sourceMeta: {
        permissions: { channelVisibility: "public" },
        timestamps: { sent: "2026-08-31T12:00:00Z" },
        author: "U123",
        permalink: "https://example.slack.com/archives/C42/p1725001",
      },
    };

    const first = await putRawArtifact(deps, input);
    expect(first.created).toBe(true);

    const again = await putRawArtifact(deps, { ...input, payload: { text: "retry duplicate" } });
    expect(again.created).toBe(false);
    expect(again.artifactId).toBe(first.artifactId);

    // envelope preserves source metadata and the original payload
    const envelope = await getRawArtifact(deps, first.objectKey);
    expect(envelope.sourceMeta.permalink).toBe(input.sourceMeta.permalink);
    expect((envelope.payload as { text: string }).text).toBe("we decided to ship tuesday");

    const rows = await db
      .select()
      .from(tables.rawArtifacts)
      .where(eq(tables.rawArtifacts.sourceKey, sourceKey));
    expect(rows).toHaveLength(1);
  });

  it("chains collect → normalize → triage → extract", async () => {
    const sourceKey = `C7:${randomUUID()}`;
    const base = { source: "slack" as const, sourceKey };

    queued.length = 0;
    await handlers.collect(deps, {
      kind: "collect",
      ...base,
      payload: {
        artifact: {
          // signal keyword so the triage heuristics pass it without a model
          payload: { messages: [{ ts: "1.0", user: "U9", text: "the release is blocked on QA" }] },
          sourceMeta: { author: "U9" },
        },
      },
      enqueuedAt: new Date().toISOString(),
    });
    expect(queued.map((j) => j.kind)).toEqual(["normalize"]);

    await handlers.normalize(deps, queued[0]!);
    expect(queued.map((j) => j.kind)).toEqual(["normalize", "triage"]);

    await handlers.triage(deps, queued[1]!);
    expect(queued.map((j) => j.kind)).toEqual(["normalize", "triage", "extract"]);
    expect((queued[2]!.payload.triage as { score: number }).score).toBeGreaterThan(0.5);

    // extract is a section-4 placeholder; must acknowledge without enqueueing
    await handlers.extract(deps, queued[2]!);
    expect(queued).toHaveLength(3);

    // duplicate collect must not re-trigger the chain
    queued.length = 0;
    await handlers.collect(deps, {
      kind: "collect",
      ...base,
      payload: {
        artifact: {
          payload: { messages: [{ ts: "1.0", user: "U9", text: "the release is blocked on QA" }] },
          sourceMeta: {},
        },
      },
      enqueuedAt: new Date().toISOString(),
    });
    expect(queued).toHaveLength(0);
  });

  it("records an ok sync_runs row with the connector's counts", async () => {
    const startedAt = new Date();
    await recordSyncRun(deps, {
      source: "gitlab",
      status: "ok",
      counts: { workItems: 12, events: 3 },
      startedAt,
    });

    const rows = await db
      .select()
      .from(tables.syncRuns)
      .where(gte(tables.syncRuns.startedAt, startedAt));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("gitlab");
    expect(rows[0]!.status).toBe("ok");
    expect(rows[0]!.counts).toEqual({ workItems: 12, events: 3 });
    expect(rows[0]!.error).toBeNull();
    expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records a failed sync_runs row and re-throws when a connector fails", async () => {
    const before = new Date();
    const prev = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    try {
      await expect(
        handlers.sync(deps, {
          kind: "sync",
          source: "slack",
          payload: {},
          enqueuedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/SLACK_BOT_TOKEN/);
    } finally {
      if (prev !== undefined) process.env.SLACK_BOT_TOKEN = prev;
    }

    const rows = await db
      .select()
      .from(tables.syncRuns)
      .where(gte(tables.syncRuns.startedAt, before));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("slack");
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error).toMatch(/SLACK_BOT_TOKEN/);
  });

  it("swallows sync_runs insert failures so recording never breaks a sync", async () => {
    const brokenDeps: WorkerDeps = {
      ...deps,
      db: {
        insert: () => ({
          values: () => Promise.reject(new Error("db down")),
        }),
      } as unknown as WorkerDeps["db"],
    };
    await expect(
      recordSyncRun(brokenDeps, { source: "gitlab", status: "ok", startedAt: new Date() }),
    ).resolves.toBeUndefined();
  });

  it("round-trips jobs through the real queue", async () => {
    const enqueue = createEnqueue(sqs, queueUrl);
    const job: Job = {
      kind: "normalize",
      source: "slack",
      sourceKey: `roundtrip:${randomUUID()}`,
      payload: {},
      enqueuedAt: new Date().toISOString(),
    };
    await enqueue([job]);

    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 5 }),
    );
    expect(Messages).toHaveLength(1);
    const parsed = jobSchema.parse(JSON.parse(Messages![0]!.Body!));
    expect(parsed.sourceKey).toBe(job.sourceKey);
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: Messages![0]!.ReceiptHandle }),
    );
  });
});

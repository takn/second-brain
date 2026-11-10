/**
 * Replay tooling (task 3.1): re-run pipeline stages over stored raw artifacts.
 * All downstream writes are idempotent upserts, so replaying any range is safe.
 *
 * Usage:
 *   pnpm --filter worker replay [--source slack] [--from 2026-08-01] [--to 2026-09-01] [--stage normalize] [--dry-run]
 */
import { parseArgs } from "node:util";
import { and, eq, gte, lt } from "drizzle-orm";
import { createDb, SOURCES, tables, type Job, type Source } from "@second-brain/schema";
import pino from "pino";
import { createEnqueue, createSqsClient, resolveQueueUrl } from "./lib/deps.ts";

const logger = pino({ transport: { target: "pino-pretty" } });

const { values: args } = parseArgs({
  allowPositionals: true, // tolerate a stray "--" from `pnpm run … -- …`
  options: {
    source: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    stage: { type: "string", default: "normalize" },
    "dry-run": { type: "boolean", default: false },
  },
});

const stage = args.stage as Job["kind"];
if (!["normalize", "triage", "extract"].includes(stage)) {
  logger.error(`--stage must be normalize, triage, or extract (got ${stage})`);
  process.exit(1);
}
if (args.source && !SOURCES.includes(args.source as Source)) {
  logger.error(`--source must be one of ${SOURCES.join(", ")}`);
  process.exit(1);
}

const conditions = [];
if (args.source) conditions.push(eq(tables.rawArtifacts.source, args.source));
if (args.from) conditions.push(gte(tables.rawArtifacts.collectedAt, new Date(args.from)));
if (args.to) conditions.push(lt(tables.rawArtifacts.collectedAt, new Date(args.to)));

const { db, sql } = createDb();
try {
  const artifacts = await db
    .select({
      source: tables.rawArtifacts.source,
      sourceKey: tables.rawArtifacts.sourceKey,
    })
    .from(tables.rawArtifacts)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  logger.info(
    { count: artifacts.length, stage, source: args.source ?? "all" },
    args["dry-run"] ? "dry run — nothing enqueued" : "replaying",
  );

  if (!args["dry-run"] && artifacts.length > 0) {
    const sqs = createSqsClient();
    const queueUrl = await resolveQueueUrl(sqs, process.env.SQS_QUEUE_JOBS ?? "brain-jobs");
    const enqueue = createEnqueue(sqs, queueUrl);
    await enqueue(
      artifacts.map((a) => ({
        kind: stage,
        source: a.source as Source,
        sourceKey: a.sourceKey,
        payload: { replay: true },
        enqueuedAt: new Date().toISOString(),
      })),
    );
    logger.info({ count: artifacts.length }, "enqueued");
  }
} finally {
  await sql.end();
}

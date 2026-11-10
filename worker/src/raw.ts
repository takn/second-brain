/**
 * S3 raw collection layer (task 3.1). Every collected artifact lands here —
 * immutably in the object store plus a registry row — before any processing.
 *
 * Idempotency: `sourceKey` is the stable per-source key (slack ts, gitlab
 * event id, drive file+revision). Re-collecting an existing key is a no-op,
 * which makes connector retries and backfills safe.
 */
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { tables, type Source } from "@second-brain/schema";
import type { WorkerDeps } from "./lib/deps.ts";

/** Source metadata preserved on every artifact (ingestion-pipeline spec). */
export interface SourceMeta {
  /** Original permissions context, e.g. slack channel visibility. */
  permissions?: unknown;
  /** Original timestamps from the source system. */
  timestamps?: Record<string, string>;
  /** Author/speaker identity as the source provides it. */
  author?: unknown;
  /** Permalink or reference to the original. */
  permalink?: string;
  [key: string]: unknown;
}

export interface RawArtifactInput {
  source: Source;
  sourceKey: string;
  /** JSON-serializable payload as collected, unmodified. */
  payload: unknown;
  sourceMeta: SourceMeta;
  collectedAt?: Date;
}

/** Deterministic object key: readable prefix + digest so any sourceKey is S3-safe. */
export function objectKeyFor(source: string, sourceKey: string, collectedAt: Date): string {
  const digest = createHash("sha256").update(sourceKey).digest("hex").slice(0, 16);
  const safe = sourceKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  const yyyy = collectedAt.getUTCFullYear();
  const mm = String(collectedAt.getUTCMonth() + 1).padStart(2, "0");
  return `raw/${source}/${yyyy}/${mm}/${safe}-${digest}.json`;
}

export async function putRawArtifact(
  deps: Pick<WorkerDeps, "db" | "s3" | "bucket">,
  input: RawArtifactInput,
): Promise<{ artifactId: string; objectKey: string; created: boolean }> {
  const [existing] = await deps.db
    .select({ id: tables.rawArtifacts.id, objectKey: tables.rawArtifacts.objectKey })
    .from(tables.rawArtifacts)
    .where(eq(tables.rawArtifacts.sourceKey, input.sourceKey));
  if (existing) {
    return { artifactId: existing.id, objectKey: existing.objectKey, created: false };
  }

  const collectedAt = input.collectedAt ?? new Date();
  const objectKey = objectKeyFor(input.source, input.sourceKey, collectedAt);

  // Self-contained envelope so the pipeline can replay from S3 alone.
  await deps.s3.send(
    new PutObjectCommand({
      Bucket: deps.bucket,
      Key: objectKey,
      ContentType: "application/json",
      Body: JSON.stringify({
        source: input.source,
        sourceKey: input.sourceKey,
        collectedAt: collectedAt.toISOString(),
        sourceMeta: input.sourceMeta,
        payload: input.payload,
      }),
    }),
  );

  const inserted = await deps.db
    .insert(tables.rawArtifacts)
    .values({
      source: input.source,
      sourceKey: input.sourceKey,
      objectKey,
      sourceMeta: input.sourceMeta,
      collectedAt,
    })
    .onConflictDoNothing({ target: tables.rawArtifacts.sourceKey })
    .returning({ id: tables.rawArtifacts.id });

  if (inserted[0]) return { artifactId: inserted[0].id, objectKey, created: true };

  // Lost a concurrent race; the other writer's row wins (same immutable content).
  const [row] = await deps.db
    .select({ id: tables.rawArtifacts.id, objectKey: tables.rawArtifacts.objectKey })
    .from(tables.rawArtifacts)
    .where(eq(tables.rawArtifacts.sourceKey, input.sourceKey));
  if (!row) throw new Error(`raw artifact vanished for ${input.sourceKey}`);
  return { artifactId: row.id, objectKey: row.objectKey, created: false };
}

export interface RawEnvelope {
  source: Source;
  sourceKey: string;
  collectedAt: string;
  sourceMeta: SourceMeta;
  payload: unknown;
}

export async function getRawArtifact(
  deps: Pick<WorkerDeps, "s3" | "bucket">,
  objectKey: string,
): Promise<RawEnvelope> {
  const res = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: objectKey }));
  const body = await res.Body?.transformToString();
  if (!body) throw new Error(`empty raw artifact object: ${objectKey}`);
  return JSON.parse(body) as RawEnvelope;
}

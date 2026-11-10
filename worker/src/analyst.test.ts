import { randomUUID } from "node:crypto";
import { CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { applyMigrations, createEvent, tables } from "@second-brain/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeImpact, designGaps, detectDependencies } from "./analyst.ts";
import { createS3Client, type WorkerDeps } from "./lib/deps.ts";
import type { Llm, LlmResponse } from "./lib/llm.ts";

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

/** Llm stub returning a fixed tool-use payload per call, counting invocations. */
function fakeLlm(inputs: unknown[]): { llm: Llm; count: () => number } {
  let calls = 0;
  const llm = {
    invoke: async () => {
      const input = inputs[Math.min(calls, inputs.length - 1)];
      calls++;
      return {
        text: "",
        message: { role: "assistant", content: [{ toolUse: { name: "tool", input } }] },
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 100 },
        costUsd: 0.005,
        modelId: "fake-mid",
      } as unknown as LlmResponse;
    },
    spentTodayUsd: async () => 0,
    config: {} as Llm["config"],
  } as unknown as Llm;
  return { llm, count: () => calls };
}

describe.skipIf(!stackUp)("analyst", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  let dependentId: string;
  let dependentSlug: string;
  let prerequisiteId: string;
  let prerequisiteSlug: string;
  let artifactId: string;

  function makeDeps(llm?: Llm): WorkerDeps {
    return {
      db,
      s3: createS3Client(s3Env),
      bucket,
      enqueue: () => {},
      logger: pino({ level: "silent" }),
      llm,
    };
  }

  beforeAll(async () => {
    await applyMigrations(sql);
    dependentSlug = `dep-a-${randomUUID().slice(0, 8)}`;
    prerequisiteSlug = `dep-b-${randomUUID().slice(0, 8)}`;
    const [a] = await db
      .insert(tables.projects)
      .values({ slug: dependentSlug, name: "Analyst Dependent Project" })
      .returning();
    const [b] = await db
      .insert(tables.projects)
      .values({ slug: prerequisiteSlug, name: "Analyst Prerequisite Project" })
      .returning();
    dependentId = a!.id;
    prerequisiteId = b!.id;
    const [artifact] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "slack", sourceKey: `analyst:${randomUUID()}`, objectKey: "raw/a.json" })
      .returning();
    artifactId = artifact!.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("records a dependency from a multi-project event, then retires it when the event dies", async () => {
    const { eventId } = await createEvent(db, {
      type: "blocker_raised",
      title: "Dependent launch blocked on prerequisite API",
      confidence: 0.9,
      artifactId,
      projectIds: [dependentId, prerequisiteId],
    });

    const { llm } = fakeLlm([
      {
        dependencies: [
          {
            dependent_slug: dependentSlug,
            prerequisite_slug: prerequisiteSlug,
            summary: "Launch waits on the prerequisite API",
            event_ids: [eventId],
          },
        ],
      },
    ]);
    const first = await detectDependencies(makeDeps(llm));
    expect(first.detected).toBe(1);

    const [dep] = await db
      .select()
      .from(tables.dependencies)
      .where(eq(tables.dependencies.dedupeKey, `dependency:${dependentId}:${prerequisiteId}:${eventId}`));
    expect(dep).toBeDefined();
    expect(dep!.status).toBe("open");

    // Idempotent re-run: same detection refreshes rather than duplicates.
    await detectDependencies(makeDeps(llm));
    const rows = await db
      .select()
      .from(tables.dependencies)
      .where(eq(tables.dependencies.dependentProjectId, dependentId));
    expect(rows).toHaveLength(1);

    // Citing event superseded → dependency retires even with no LLM available.
    await db.update(tables.events).set({ status: "superseded" }).where(eq(tables.events.id, eventId));
    const second = await detectDependencies(makeDeps());
    expect(second.resolved).toBeGreaterThanOrEqual(1);
    const [after] = await db
      .select()
      .from(tables.dependencies)
      .where(eq(tables.dependencies.id, dep!.id));
    expect(after!.status).toBe("resolved");
  });

  it("flags change impact on the dependent project when the prerequisite slips", async () => {
    const { eventId: sourceEvent } = await createEvent(db, {
      type: "decision",
      title: "Analyst impact source claim",
      confidence: 0.9,
      artifactId,
      projectIds: [dependentId, prerequisiteId],
    });
    const [dep] = await db
      .insert(tables.dependencies)
      .values({
        dependentProjectId: dependentId,
        prerequisiteProjectId: prerequisiteId,
        summary: "Needs the prerequisite data pipeline",
        refs: { eventIds: [sourceEvent] },
        dedupeKey: `dependency:test:${randomUUID()}`,
      })
      .returning();

    const { eventId: cause } = await createEvent(db, {
      type: "deadline_slipped",
      title: "Prerequisite pipeline slips to Q2",
      confidence: 0.9,
      artifactId,
      projectIds: [prerequisiteId],
    });

    const findings = await changeImpact(makeDeps());
    const hit = findings.find((f) => f.dedupeKey === `change_impact:${dep!.id}:${cause}`);
    expect(hit).toBeDefined();
    expect(hit!.projectId).toBe(dependentId);
    expect(hit!.summary).toContain("Prerequisite pipeline slips");

    // Cause superseded → no longer detected (lintAll's sweep then resolves it).
    await db.update(tables.events).set({ status: "superseded" }).where(eq(tables.events.id, cause));
    const later = await changeImpact(makeDeps());
    expect(later.find((f) => f.dedupeKey === `change_impact:${dep!.id}:${cause}`)).toBeUndefined();
  });

  it("files design-gap findings for uncovered scope and analyzes each doc once", async () => {
    const fileId = `file-${randomUUID().slice(0, 8)}`;
    const objectKey = `raw/gws/${fileId}.json`;
    const designText = `Design: Dependent Project Phase 2. Scope: (1) export API, (2) audit log UI, (3) SSO integration. ${"x".repeat(600)}`;
    const s3 = createS3Client(s3Env);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: JSON.stringify({
          source: "gws",
          sourceKey: `gws:drive:${fileId}:2026-09-01T00:00:00Z`,
          payload: { surface: "drive", fileName: "phase-2-design", mimeType: "application/vnd.google-apps.document", content: designText },
          sourceMeta: { permalink: "https://docs.google.com/document/d/x" },
        }),
      }),
    );
    const [doc] = await db
      .insert(tables.rawArtifacts)
      .values({
        source: "gws",
        sourceKey: `gws:drive:${fileId}:2026-09-01T00:00:00Z`,
        objectKey,
        sourceMeta: { permalink: "https://docs.google.com/document/d/x" },
      })
      .returning();

    // Call 1 classifies, call 2 emits gaps.
    const { llm, count } = fakeLlm([
      { is_design_doc: true, project_slug: dependentSlug },
      { gaps: [{ summary: "Audit log UI has no tracked work item", detail: "Design scope (2)" }] },
    ]);
    const result = await designGaps(makeDeps(llm));
    expect(result.docsAnalyzed).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.projectId).toBe(dependentId);
    expect(result.findings[0]!.dedupeKey.startsWith(`design_gap:${doc!.id}:`)).toBe(true);
    const callsAfterFirst = count();

    // Second pass: the analyzed marker prevents re-invoking the model.
    const again = await designGaps(makeDeps(llm));
    expect(again.docsAnalyzed).toBe(0);
    expect(count()).toBe(callsAfterFirst);

    const [marker] = await db
      .select()
      .from(tables.connectorState)
      .where(eq(tables.connectorState.key, `analyst:gap:${doc!.id}`));
    expect(marker).toBeDefined();
  });

  it("skips non-design docs after classification", async () => {
    const fileId = `file-${randomUUID().slice(0, 8)}`;
    const objectKey = `raw/gws/${fileId}.json`;
    const s3 = createS3Client(s3Env);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: JSON.stringify({
          source: "gws",
          sourceKey: `gws:drive:${fileId}:2026-09-01T00:00:00Z`,
          payload: { surface: "drive", fileName: "weekly-sync-transcript", mimeType: "application/vnd.google-apps.document", content: `Transcript of the weekly sync. ${"y".repeat(600)}` },
          sourceMeta: {},
        }),
      }),
    );
    const [doc] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "gws", sourceKey: `gws:drive:${fileId}:2026-09-01T00:00:00Z`, objectKey })
      .returning();

    const { llm, count } = fakeLlm([{ is_design_doc: false, project_slug: null }]);
    const result = await designGaps(makeDeps(llm));
    expect(result.findings).toHaveLength(0);
    expect(count()).toBe(1); // classify only, no gap call

    const [marker] = await db
      .select()
      .from(tables.connectorState)
      .where(eq(tables.connectorState.key, `analyst:gap:${doc!.id}`));
    expect(marker).toBeDefined();
  });

  it("surfaces the dependency on both projects via directional queries", async () => {
    const [dep] = await db
      .insert(tables.dependencies)
      .values({
        dependentProjectId: dependentId,
        prerequisiteProjectId: prerequisiteId,
        summary: "Bidirectional visibility check",
        refs: {},
        dedupeKey: `dependency:test:${randomUUID()}`,
      })
      .returning();

    const [fromDependent] = await db
      .select()
      .from(tables.dependencies)
      .where(
        and(
          eq(tables.dependencies.dependentProjectId, dependentId),
          eq(tables.dependencies.id, dep!.id),
        ),
      );
    const [fromPrerequisite] = await db
      .select()
      .from(tables.dependencies)
      .where(
        and(
          eq(tables.dependencies.prerequisiteProjectId, prerequisiteId),
          eq(tables.dependencies.id, dep!.id),
        ),
      );
    expect(fromDependent).toBeDefined();
    expect(fromPrerequisite).toBeDefined();
  });
});

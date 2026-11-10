import { randomUUID } from "node:crypto";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { applyMigrations, tables } from "@second-brain/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractArtifact } from "./extractor.ts";
import { createS3Client, type WorkerDeps } from "./lib/deps.ts";
import type { Llm, LlmResponse } from "./lib/llm.ts";
import { putRawArtifact } from "./raw.ts";

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

/** Llm stub returning a queue of toolUse payloads. */
function fakeLlm(inputs: unknown[]): { llm: Llm; calls: number[] } {
  const calls: number[] = [];
  const llm = {
    invoke: async () => {
      calls.push(1);
      const input = inputs.shift();
      return {
        text: "",
        message: { role: "assistant", content: [{ toolUse: { name: "emit_events", input } }] },
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 100 },
        costUsd: 0.001,
        modelId: "fake-mid",
      } as unknown as LlmResponse;
    },
    spentTodayUsd: async () => 0,
    config: {} as Llm["config"],
  } as unknown as Llm;
  return { llm, calls };
}

describe.skipIf(!stackUp)("extractor", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  const runId = randomUUID().slice(0, 8);
  // Must match the extractor's Jira-key regex: letters, dash, digits.
  const jiraKey = `EXTR-${Math.floor(Math.random() * 1e6)}`;
  let projectSlug: string;
  let projectId: string;

  function makeDeps(llm: Llm): WorkerDeps {
    return {
      db,
      s3: createS3Client(s3Env),
      bucket,
      enqueue: () => {},
      logger: pino({ level: "silent" }),
      llm,
    };
  }

  async function slackArtifact(deps: WorkerDeps, text: string) {
    const sourceKey = `T1:CX:${randomUUID()}`;
    const { artifactId } = await putRawArtifact(deps, {
      source: "slack",
      sourceKey,
      payload: {
        channelId: "CX",
        messages: [
          { ts: "100.1", user: "U1", text },
          { ts: "100.2", user: "U2", text: "ack" },
        ],
      },
      sourceMeta: { channelName: "eng", permalink: "https://slack/p100" },
    });
    const [row] = await db
      .select()
      .from(tables.rawArtifacts)
      .where(eq(tables.rawArtifacts.id, artifactId));
    return row!;
  }

  beforeAll(async () => {
    await applyMigrations(sql);
    projectSlug = `extract-proj-${runId}`;
    const [p] = await db
      .insert(tables.projects)
      .values({ slug: projectSlug, name: "Extract Test Project" })
      .returning();
    projectId = p!.id;
    // a mirrored jira work item for the matching test
    await db.insert(tables.workItems).values({
      source: "jira",
      kind: "issue",
      sourceId: jiraKey,
      title: "Mirrored item",
      state: "new",
      webUrl: `https://example.atlassian.net/browse/${jiraKey}`,
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("creates schema-valid events with provenance, spans, and project links; dedupes replays", async () => {
    const valid = {
      events: [
        {
          type: "deadline_slipped",
          title: "Migration deadline moved to next Friday",
          confidence: 0.9,
          span: { from: "100.1", to: "100.1" },
          project_slugs: [projectSlug, "nonexistent-slug"],
        },
      ],
    };
    const { llm } = fakeLlm([valid, valid]);
    const deps = makeDeps(llm);
    const row = await slackArtifact(deps, "the migration deadline moved to next friday");

    const first = await extractArtifact(deps, row, await envelopeOf(deps, row));
    expect(first).toEqual({ events: 1, parked: false });

    const events = await db
      .select()
      .from(tables.events)
      .where(eq(tables.events.artifactId, row.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "deadline_slipped",
      confidence: 0.9,
      permalink: "https://slack/p100",
    });
    expect(events[0]!.span).toEqual({ from: "100.1", to: "100.1" });

    const links = await db
      .select()
      .from(tables.eventProjects)
      .where(eq(tables.eventProjects.eventId, events[0]!.id));
    expect(links.map((l) => l.projectId)).toEqual([projectId]); // bad slug dropped

    // replay: same artifact, same dedupe keys → no duplicates
    const second = await extractArtifact(deps, row, await envelopeOf(deps, row));
    expect(second.events).toBe(0);
    const after = await db
      .select()
      .from(tables.events)
      .where(eq(tables.events.artifactId, row.id));
    expect(after).toHaveLength(1);
  });

  it("retries once with feedback, then parks — no partial writes", async () => {
    const invalid = { events: [{ type: "not-a-type", title: "x" }] };
    const { llm, calls } = fakeLlm([invalid, invalid]);
    const deps = makeDeps(llm);
    const row = await slackArtifact(deps, "garbled discussion");

    const result = await extractArtifact(deps, row, await envelopeOf(deps, row));
    expect(result.parked).toBe(true);
    expect(calls).toHaveLength(2); // initial + one feedback retry

    const [parked] = await db
      .select()
      .from(tables.parkedArtifacts)
      .where(eq(tables.parkedArtifacts.artifactId, row.id));
    expect(parked).toMatchObject({ stage: "extract", attempts: 2 });

    const events = await db
      .select()
      .from(tables.events)
      .where(eq(tables.events.artifactId, row.id));
    expect(events).toHaveLength(0);
  });

  it("recovers when the feedback retry produces valid output", async () => {
    const invalid = { events: [{ type: "decision" }] };
    const valid = {
      events: [
        {
          type: "decision",
          title: "Decided to adopt the new deploy process",
          confidence: 0.8,
          span: { from: "100.1", to: "100.2" },
          project_slugs: [projectSlug],
        },
      ],
    };
    const { llm, calls } = fakeLlm([invalid, valid]);
    const deps = makeDeps(llm);
    const row = await slackArtifact(deps, "we decided to adopt the new deploy process");

    const result = await extractArtifact(deps, row, await envelopeOf(deps, row));
    expect(result).toEqual({ events: 1, parked: false });
    expect(calls).toHaveLength(2);
  });

  it("links action items to mirrored work items by jira key, else files untracked work", async () => {
    const { llm } = fakeLlm([
      {
        events: [
          {
            type: "action_item",
            title: `Sam to finish the rollout plan tracked in ${jiraKey}`,
            confidence: 0.85,
            span: { from: "100.1", to: "100.1" },
            project_slugs: [projectSlug],
          },
          {
            type: "action_item",
            title: "Someone should document the failover runbook",
            confidence: 0.7,
            span: { from: "100.2", to: "100.2" },
            project_slugs: [projectSlug],
          },
        ],
      },
    ]);
    const deps = makeDeps(llm);
    const row = await slackArtifact(deps, "action items thread");

    await extractArtifact(deps, row, await envelopeOf(deps, row));

    const events = await db
      .select()
      .from(tables.events)
      .where(eq(tables.events.artifactId, row.id));
    const linked = events.find((e) => e.title.includes(jiraKey));
    const unlinked = events.find((e) => e.title.includes("runbook"));
    expect(linked!.workItemId).not.toBeNull();
    expect(unlinked!.workItemId).toBeNull();

    const [untracked] = await db
      .select()
      .from(tables.untrackedWork)
      .where(eq(tables.untrackedWork.eventId, unlinked!.id));
    expect(untracked).toMatchObject({ projectId, status: "open" });
  });

  async function envelopeOf(deps: WorkerDeps, row: { objectKey: string }) {
    const { getRawArtifact } = await import("./raw.ts");
    return getRawArtifact(deps, row.objectKey);
  }
});

import { randomUUID } from "node:crypto";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { applyMigrations, createEvent, tables, type Job } from "@second-brain/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Client, type WorkerDeps } from "./lib/deps.ts";
import type { Llm, LlmResponse } from "./lib/llm.ts";
import { scheduleSynthesis, sanitizeSynthesisInput, synthesizeProject } from "./synthesizer.ts";

describe("sanitizeSynthesisInput", () => {
  it("truncates long summaries and drops non-UUID citations", () => {
    const good = "3f8b7f09-808e-4243-8d04-3a22b81e1e38";
    const sanitized = sanitizeSynthesisInput({
      narrative_markdown: "x".repeat(60),
      summary: "s".repeat(600),
      cited_event_ids: [good, "not-a-uuid", "event:foo", 42],
      superseded: [
        { old_event_id: good, new_event_id: good },
        { old_event_id: "bad", new_event_id: good },
      ],
      contradictions: [
        {
          event_a_id: good,
          event_b_id: good,
          summary: "c".repeat(600),
          resolution: "r".repeat(1200),
        },
        { event_a_id: "nope", event_b_id: good, summary: "too short", resolution: "x" },
      ],
    }) as {
      summary: string;
      cited_event_ids: string[];
      superseded: unknown[];
      contradictions: { summary: string; resolution: string }[];
    };

    expect(sanitized.summary).toHaveLength(500);
    expect(sanitized.cited_event_ids).toEqual([good]);
    expect(sanitized.superseded).toHaveLength(1);
    expect(sanitized.contradictions).toHaveLength(1);
    expect(sanitized.contradictions[0]!.summary).toHaveLength(500);
    expect(sanitized.contradictions[0]!.resolution).toHaveLength(1000);
  });
});

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

function fakeLlm(makeInput: (callIndex: number) => unknown): { llm: Llm; calls: number } {
  const state = { calls: 0 };
  const llm = {
    invoke: async () => {
      const input = makeInput(state.calls++);
      return {
        text: "",
        message: { role: "assistant", content: [{ toolUse: { name: "emit_synthesis", input } }] },
        stopReason: "tool_use",
        usage: { inputTokens: 500, outputTokens: 500 },
        costUsd: 0.01,
        modelId: "fake-frontier",
      } as unknown as LlmResponse;
    },
    spentTodayUsd: async () => 0,
    config: {} as Llm["config"],
  } as unknown as Llm;
  return { llm, get calls() { return state.calls; } } as { llm: Llm; calls: number };
}

describe.skipIf(!stackUp)("synthesizer", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  let projectId: string;
  let artifactId: string;
  let oldDeadline: string;
  let newDeadline: string;
  let decision: string;

  function makeDeps(llm?: Llm, queued?: { jobs: Job[]; opts?: { delaySeconds?: number } }[]): WorkerDeps {
    return {
      db,
      s3: createS3Client(s3Env),
      bucket,
      enqueue: (jobs, opts) => {
        queued?.push({ jobs, opts });
      },
      logger: pino({ level: "silent" }),
      llm,
    };
  }

  beforeAll(async () => {
    await applyMigrations(sql);
    const [project] = await db
      .insert(tables.projects)
      .values({ slug: `synth-${randomUUID().slice(0, 8)}`, name: "Synth Test Project" })
      .returning();
    projectId = project!.id;
    const [artifact] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "slack", sourceKey: `synth:${randomUUID()}`, objectKey: "raw/x.json" })
      .returning();
    artifactId = artifact!.id;

    const mk = async (type: "deadline_set" | "deadline_slipped" | "decision", title: string) =>
      (
        await createEvent(db, {
          type,
          title,
          confidence: 0.9,
          artifactId,
          projectIds: [projectId],
        })
      ).eventId;
    oldDeadline = await mk("deadline_set", "Release scheduled for Sep 30");
    newDeadline = await mk("deadline_slipped", "Release moved to Oct 14");
    decision = await mk("decision", "Team decided to adopt blue-green deploys");
  });

  afterAll(async () => {
    await sql.end();
  });

  it("writes a cited revision, supersede marks, and contradiction rows", async () => {
    const { llm } = fakeLlm(() => ({
      narrative_markdown:
        "## Status\nRelease now targets Oct 14 [event:" +
        newDeadline +
        "] after slipping from Sep 30. The team adopted blue-green deploys [event:" +
        decision +
        "].",
      summary: "Deadline slipped; deploy strategy decided.",
      cited_event_ids: [newDeadline, decision, oldDeadline],
      superseded: [{ old_event_id: oldDeadline, new_event_id: newDeadline }],
      contradictions: [
        {
          event_a_id: newDeadline,
          event_b_id: decision,
          summary: "Deploy strategy assumes the September window",
          resolution: "Follow the newer deadline event",
        },
      ],
    }));
    const deps = makeDeps(llm);

    const result = await synthesizeProject(deps, projectId);
    expect(result.revision).toBe(1);
    expect(result.superseded).toBe(1);
    expect(result.contradictions).toBe(1);

    // narrative head + citations (superseded event excluded from citations)
    const [narrative] = await db
      .select()
      .from(tables.narratives)
      .where(eq(tables.narratives.projectId, projectId));
    expect(narrative!.currentRevisionId).not.toBeNull();
    const citations = await db
      .select()
      .from(tables.narrativeCitations)
      .where(eq(tables.narrativeCitations.revisionId, narrative!.currentRevisionId!));
    expect(citations.map((c) => c.eventId).sort()).toEqual([newDeadline, decision].sort());

    // supersede mark
    const [old] = await db.select().from(tables.events).where(eq(tables.events.id, oldDeadline));
    expect(old).toMatchObject({ status: "superseded", supersededById: newDeadline });

    // contradiction row
    const rows = await db
      .select()
      .from(tables.contradictions)
      .where(eq(tables.contradictions.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open" });
  });

  it("skips without an LLM call when nothing changed (debounce guard)", async () => {
    const fake = fakeLlm(() => {
      throw new Error("should not be called");
    });
    const result = await synthesizeProject(makeDeps(fake.llm), projectId);
    expect(result.skipped).toContain("no new events");
  });

  it("re-synthesizes on new events without duplicating contradictions", async () => {
    const blocker = (
      await createEvent(db, {
        type: "blocker_raised",
        title: "Blocked on infra quota approval",
        confidence: 0.8,
        artifactId,
        projectIds: [projectId],
      })
    ).eventId;

    const { llm } = fakeLlm(() => ({
      narrative_markdown:
        "## Status\nRelease targets Oct 14 [event:" +
        newDeadline +
        "], now blocked on quota [event:" +
        blocker +
        "].",
      cited_event_ids: [newDeadline, blocker],
      superseded: [],
      contradictions: [
        {
          event_a_id: newDeadline,
          event_b_id: decision,
          summary: "Deploy strategy assumes the September window",
          resolution: "Follow the newer deadline event",
        },
      ],
    }));

    const result = await synthesizeProject(makeDeps(llm), projectId);
    expect(result.revision).toBe(2);
    expect(result.contradictions).toBe(0); // same pair already open → deduped

    const rows = await db
      .select()
      .from(tables.contradictions)
      .where(eq(tables.contradictions.projectId, projectId));
    expect(rows).toHaveLength(1);
  });

  it("recovers when the model pads citations with junk and overshoots summary", async () => {
    await createEvent(db, {
      type: "status_change",
      title: "Sanitizer recovery event",
      confidence: 0.9,
      artifactId,
      projectIds: [projectId],
    });
    const { llm } = fakeLlm(() => ({
      narrative_markdown:
        "## Status\nRelease now targets Oct 14 [event:" +
        newDeadline +
        "] with blue-green deploys [event:" +
        decision +
        "].",
      summary: "S".repeat(600),
      cited_event_ids: [newDeadline, decision, "not-a-uuid", "event:legacy-key"],
      superseded: [],
      contradictions: [],
    }));

    const result = await synthesizeProject(makeDeps(llm), projectId);
    expect(result.revision).toBeGreaterThan(0);
    expect(result.skipped).toBeUndefined();
  });

  it("leaves the narrative untouched when validation fails twice", async () => {
    const stranger = randomUUID(); // valid uuid, not a project event
    await createEvent(db, {
      type: "status_change",
      title: "Something new happened here",
      confidence: 0.9,
      artifactId,
      projectIds: [projectId],
    });
    const fake = fakeLlm(() => ({
      narrative_markdown: "## Status\nFabricated claims with foreign citations.",
      cited_event_ids: [stranger],
      superseded: [],
      contradictions: [],
    }));

    const [before] = await db
      .select()
      .from(tables.narratives)
      .where(and(eq(tables.narratives.projectId, projectId), eq(tables.narratives.kind, "status")));

    const result = await synthesizeProject(makeDeps(fake.llm), projectId);
    expect(result.skipped).toContain("validation failed");
    expect(fake.calls).toBe(2); // initial + feedback retry

    const [after] = await db
      .select()
      .from(tables.narratives)
      .where(eq(tables.narratives.id, before!.id));
    expect(after!.currentRevisionId).toBe(before!.currentRevisionId);
  });

  it("schedules debounced synthesis per unique project", async () => {
    const queued: { jobs: Job[]; opts?: { delaySeconds?: number } }[] = [];
    const deps = makeDeps(undefined, queued);
    await scheduleSynthesis(deps, [projectId, projectId, projectId]);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.jobs).toHaveLength(1);
    expect(queued[0]!.jobs[0]).toMatchObject({ kind: "synthesize", payload: { projectId } });
    expect(queued[0]!.opts?.delaySeconds).toBe(120);
  });
});

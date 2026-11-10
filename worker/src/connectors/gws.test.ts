import { randomUUID } from "node:crypto";
import { CreateBucketCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { applyMigrations, tables, type Job } from "@second-brain/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Client, type WorkerDeps } from "../lib/deps.ts";
import { mapGwsArtifact, syncGws, type GwsCall, type GwsConfig } from "./gws.ts";
import { getRawArtifact } from "../raw.ts";
import { normalizeTranscript } from "./transcripts.ts";

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

describe("transcript normalization (pure)", () => {
  it("parses WebVTT with voice tags as confirmed attribution", () => {
    const t = normalizeTranscript(
      "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Nelson Alexander>we decided to ship tuesday</v>\n\n00:00:05.000 --> 00:00:08.000\nunattributed mumbling",
      "meeting.vtt",
    );
    expect(t!.origin).toBe("vtt");
    expect(t!.segments[0]).toMatchObject({
      speaker: "Nelson Alexander",
      attributionConfirmed: true,
    });
    expect(t!.segments[1]).toMatchObject({ speaker: null, attributionConfirmed: false });
  });

  it("parses Zoom txt exports", () => {
    const t = normalizeTranscript(
      "10:01:15 Sam Porter: the deadline moved\n10:01:40 Nelson Alexander: agreed, updating the plan",
      "GMT20260905-recording.txt",
    );
    expect(t!.origin).toBe("zoom-txt");
    expect(t!.segments).toHaveLength(2);
    expect(t!.segments[1]).toMatchObject({
      speaker: "Nelson Alexander",
      startTs: "10:01:40",
      attributionConfirmed: true,
    });
  });

  it("parses Meet doc exports of speaker-labeled paragraphs", () => {
    const t = normalizeTranscript(
      "Sam Porter: welcome everyone\nNelson Alexander: let's review the milestone\nSam Porter: sounds good",
      "Team sync - Transcript",
    );
    expect(t!.origin).toBe("meet-doc");
    expect(t!.segments.every((s) => s.attributionConfirmed)).toBe(true);
  });

  it("returns null for non-transcript documents", () => {
    expect(
      normalizeTranscript(
        "Quarterly report\n\nThis document summarizes progress across all projects.",
        "report.txt",
      ),
    ).toBeNull();
  });
});

describe.skipIf(!stackUp)("gws connector (integration)", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  const queued: Job[] = [];
  const deps: WorkerDeps = {
    db,
    s3: createS3Client(s3Env),
    bucket,
    enqueue: (jobs) => {
      queued.push(...jobs);
    },
    logger: pino({ level: "silent" }),
  };

  const config: GwsConfig = {
    serviceAccountKey: { client_email: "sa@test", private_key: "unused" },
    subject: "brain@test",
    watchedFolderId: "DRIVE1",
    domain: "test.org",
    denylist: new Set(["FILE-DENIED", "denied@test.org"]),
  };

  const runId = randomUUID().slice(0, 8);
  const fileModified = new Date().toISOString();
  const vtt =
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Sam Porter>the launch slipped a week</v>";

  /** Fake Google API covering directory, calendar, and drive. */
  const call: GwsCall = async (url) => {
    if (url.includes("admin/directory")) {
      return {
        users: [
          { id: "g1", primaryEmail: `known-${runId}@test.org`, name: { fullName: `Known Person ${runId}` } },
          { id: "g2", primaryEmail: `gitlabber-${runId}@test.org`, name: { fullName: `GitLab Seeded ${runId}` } },
          { id: "g3", primaryEmail: "denied@test.org", name: { fullName: "Denied Person" } },
          { id: "g4", primaryEmail: `suspended-${runId}@test.org`, name: { fullName: "Gone" }, suspended: true },
        ],
      };
    }
    if (url.includes("calendar/v3")) {
      return {
        items: [
          {
            id: `ev-${runId}`,
            updated: fileModified,
            summary: "Milestone review",
            htmlLink: "https://calendar.google.com/event?eid=x",
            organizer: { email: "brain@test" },
          },
        ],
      };
    }
    if (url.includes("/export")) return vtt;
    if (url.includes("/files?")) {
      return {
        files: [
          {
            id: `doc-${runId}`,
            name: "Team sync - Transcript",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: fileModified,
            webViewLink: "https://docs.google.com/doc",
            owners: [{ emailAddress: "sam@test.org" }],
          },
          {
            id: "FILE-DENIED",
            name: "sensitive.txt",
            mimeType: "text/plain",
            modifiedTime: fileModified,
          },
          {
            id: `rec-${runId}`,
            name: "recording.mp4",
            mimeType: "video/mp4",
            modifiedTime: fileModified,
          },
        ],
      };
    }
    throw new Error(`fake gws: unhandled ${url}`);
  };

  beforeAll(async () => {
    await applyMigrations(sql);
    // The gws cursor and daily directory snapshot are global keys; a live
    // smoke against the same DB leaves them behind — clear for isolation.
    await db.delete(tables.connectorState).where(eq(tables.connectorState.key, "gws:sync-cursor"));
    await sql`delete from raw_artifacts where source_key like 'gws:directory:%'`;
    // a GitLab-seeded person: display name, no email — directory sync should merge
    await db
      .insert(tables.people)
      .values({ displayName: `GitLab Seeded ${runId}`, gitlabUsername: `gl-${runId}` });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("collects all three surfaces, honors the denylist, and is idempotent", async () => {
    queued.length = 0;
    const first = await syncGws(deps, call, config);
    // directory snapshot + calendar event + transcript doc (denied + video skipped)
    expect(first.artifacts).toBe(3);
    expect(queued.every((j) => j.kind === "normalize" && j.source === "gws")).toBe(true);

    const second = await syncGws(deps, call, config);
    expect(second.artifacts).toBe(0); // cursors + idempotent keys
  });

  it("directory normalize upserts people and merges GitLab-seeded rows", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await db
      .select()
      .from(tables.rawArtifacts)
      .where(eq(tables.rawArtifacts.sourceKey, `gws:directory:${today}`));
    const envelope = await getRawArtifact(deps, row!.objectKey);
    await mapGwsArtifact(deps, { id: row!.id, objectKey: row!.objectKey }, envelope);

    // merged: the seeded row gained the email instead of a duplicate appearing
    const merged = await db
      .select()
      .from(tables.people)
      .where(eq(tables.people.displayName, `GitLab Seeded ${runId}`));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.email).toBe(`gitlabber-${runId}@test.org`);
    expect(merged[0]!.gitlabUsername).toBe(`gl-${runId}`);

    // new person created; denylisted + suspended people absent
    const [fresh] = await db
      .select()
      .from(tables.people)
      .where(eq(tables.people.email, `known-${runId}@test.org`));
    expect(fresh).toBeDefined();
    const denied = await db
      .select()
      .from(tables.people)
      .where(eq(tables.people.email, "denied@test.org"));
    expect(denied).toHaveLength(0);
  });

  it("drive normalize writes the standard transcript and links it on the artifact", async () => {
    const sourceKey = `gws:drive:doc-${runId}:${fileModified}`;
    const [row] = await db
      .select()
      .from(tables.rawArtifacts)
      .where(eq(tables.rawArtifacts.sourceKey, sourceKey));
    const envelope = await getRawArtifact(deps, row!.objectKey);
    await mapGwsArtifact(deps, { id: row!.id, objectKey: row!.objectKey }, envelope);

    const [after] = await db
      .select()
      .from(tables.rawArtifacts)
      .where(eq(tables.rawArtifacts.id, row!.id));
    expect(after!.normalizedObjectKey).toMatch(/^normalized\//);

    const obj = await deps.s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: after!.normalizedObjectKey! }),
    );
    const normalized = JSON.parse((await obj.Body!.transformToString()) ?? "{}");
    expect(normalized.schema).toBe("transcript.v1");
    expect(normalized.segments[0]).toMatchObject({
      speaker: "Sam Porter",
      attributionConfirmed: true,
    });
  });
});

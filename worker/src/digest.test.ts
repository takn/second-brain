import { randomUUID } from "node:crypto";
import { applyMigrations, createEvent, tables } from "@second-brain/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SlackCall } from "./connectors/slack-client.ts";
import { claimDigestRun, runDigest } from "./digest.ts";
import { createS3Client, type WorkerDeps } from "./lib/deps.ts";

const dbUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://brain:brain@localhost:54321/brain";
const s3Env = {
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000",
  S3_REGION: "us-east-1",
} as NodeJS.ProcessEnv;

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

const BASE = "https://brain.example.com";

describe.skipIf(!stackUp)("digest", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  const run = randomUUID().slice(0, 8);

  let ownedProjectId: string;
  let followedProjectId: string;
  let otherProjectId: string;
  let pocId: string;
  let followerId: string;
  let noSlackId: string;
  let artifactId: string;

  const deps: WorkerDeps = {
    db,
    s3: createS3Client(s3Env),
    bucket: "second-brain-raw",
    enqueue: () => {},
    logger: pino({ level: "silent" }),
  };

  /** Capturing Slack stub: records chat.postMessage calls. */
  function makeCall(fail = false): { call: SlackCall; messages: { channel: string; text: string }[] } {
    const messages: { channel: string; text: string }[] = [];
    const call: SlackCall = async (method, params) => {
      if (method !== "chat.postMessage") throw new Error(`unexpected method ${method}`);
      if (fail) throw new Error("slack down");
      messages.push({ channel: String(params.channel), text: String(params.text) });
      return { ok: true };
    };
    return { call, messages };
  }

  async function seedEvent(projectId: string, type: "decision" | "blocker_raised" | "status_change", title: string) {
    const { eventId } = await createEvent(db, {
      type,
      title,
      confidence: 0.9,
      artifactId,
      projectIds: [projectId],
    });
    return eventId;
  }

  beforeAll(async () => {
    await applyMigrations(sql);

    const people = await db
      .insert(tables.people)
      .values([
        {
          displayName: "Digest POC",
          email: `poc-${run}@example.com`,
          slackUserId: `UPOC${run}`,
        },
        {
          displayName: "Digest Follower",
          email: `follower-${run}@example.com`,
          slackUserId: `UFOL${run}`,
        },
        { displayName: "No Slack", email: `noslack-${run}@example.com` },
      ])
      .returning({ id: tables.people.id });
    pocId = people[0]!.id;
    followerId = people[1]!.id;
    noSlackId = people[2]!.id;

    const projects = await db
      .insert(tables.projects)
      .values([
        { slug: `digest-owned-${run}`, name: "Digest Owned", pocId },
        { slug: `digest-followed-${run}`, name: "Digest Followed", backupPocId: noSlackId },
        { slug: `digest-other-${run}`, name: "Digest Other" },
      ])
      .returning({ id: tables.projects.id });
    ownedProjectId = projects[0]!.id;
    followedProjectId = projects[1]!.id;
    otherProjectId = projects[2]!.id;

    await db
      .insert(tables.projectFollows)
      .values({ personId: followerId, projectId: followedProjectId });

    const [artifact] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "slack", sourceKey: `digest:${run}`, objectKey: "raw/digest.json" })
      .returning();
    artifactId = artifact!.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("DMs owners and followers their scoped items with deep links, skipping quiet people", async () => {
    const decisionId = await seedEvent(ownedProjectId, "decision", "Ship the digest & more");
    await seedEvent(followedProjectId, "blocker_raised", "Waiting on im:write scope");
    // Item in a project nobody owns or follows: must appear in no digest.
    await seedEvent(otherProjectId, "decision", "Unwatched decision");

    const { call, messages } = makeCall();
    const result = await runDigest(deps, call, { baseUrl: BASE });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);

    const pocMsg = messages.find((m) => m.channel === `UPOC${run}`);
    expect(pocMsg).toBeDefined();
    expect(pocMsg!.text).toContain("Digest Owned");
    // Deep link anchors into the project timeline; mrkdwn-escaped title.
    expect(pocMsg!.text).toContain(`#evt-${decisionId}`);
    expect(pocMsg!.text).toContain("Ship the digest &amp; more");
    expect(pocMsg!.text).not.toContain("Digest Followed");
    expect(pocMsg!.text).not.toContain("Unwatched");

    const followerMsg = messages.find((m) => m.channel === `UFOL${run}`);
    expect(followerMsg).toBeDefined();
    expect(followerMsg!.text).toContain("New blocker");
    expect(followerMsg!.text).toContain("Digest Followed");
    expect(followerMsg!.text).not.toContain("Digest Owned");
  });

  it("is idempotent for the day: a re-run sends nothing new", async () => {
    const { call, messages } = makeCall();
    const result = await runDigest(deps, call, { baseUrl: BASE });
    expect(result.sent).toBe(0);
    expect(messages).toHaveLength(0);
  });

  it("respects the allowlist gate", async () => {
    // Fresh day so the sent markers from the earlier test don't interfere.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const { call, messages } = makeCall();
    const result = await runDigest(deps, call, {
      baseUrl: BASE,
      allowlist: [`poc-${run}@example.com`],
      now: tomorrow,
      windowMs: 2 * 86_400_000,
    });
    expect(result.recipients).toBe(1);
    expect(result.sent).toBe(1);
    expect(messages[0]!.channel).toBe(`UPOC${run}`);
  });

  it("keeps going when one DM fails and reports it", async () => {
    const dayAfter = new Date(Date.now() + 2 * 86_400_000);
    const { call } = makeCall(true);
    const result = await runDigest(deps, call, {
      baseUrl: BASE,
      now: dayAfter,
      windowMs: 3 * 86_400_000,
    });
    expect(result.failed).toBe(result.recipients);
    expect(result.sent).toBe(0);
  });

  it("claims the daily run exactly once, and only after the send hour", async () => {
    // Isolate from other test runs by clearing the marker.
    await db.delete(tables.connectorState).where(eq(tables.connectorState.key, "digest:lastRun"));

    const beforeHour = new Date("2026-09-08T05:00:00Z");
    expect(await claimDigestRun(deps, 13, beforeHour)).toBe(false);

    const afterHour = new Date("2026-09-08T13:30:00Z");
    expect(await claimDigestRun(deps, 13, afterHour)).toBe(true);
    expect(await claimDigestRun(deps, 13, afterHour)).toBe(false);

    const nextDay = new Date("2026-09-09T13:30:00Z");
    expect(await claimDigestRun(deps, 13, nextDay)).toBe(true);
  });
});

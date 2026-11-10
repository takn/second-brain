import { randomUUID } from "node:crypto";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { applyMigrations, tables, type Job } from "@second-brain/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Client, type WorkerDeps } from "../lib/deps.ts";
import { getRawArtifact } from "../raw.ts";
import { syncSlack } from "./slack.ts";
import type { SlackCall } from "./slack-client.ts";

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

/** In-memory Slack workspace the stubbed API serves. */
function fakeSlack() {
  const team = "T001";
  const channels = [
    // public channel the bot has not joined yet — history requires membership
    { id: `C${randomUUID().slice(0, 8)}`, name: "eng-general", is_private: false, is_member: false },
    { id: `G${randomUUID().slice(0, 8)}`, name: "leads-private", is_private: true, is_member: true },
  ];
  const joined = new Set(channels.filter((c) => c.is_member).map((c) => c.id));
  const members: {
    id: string;
    name?: string;
    real_name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    profile?: { email?: string; display_name?: string; real_name?: string };
  }[] = [];
  const messages = new Map<string, { ts: string; thread_ts?: string; user?: string; text?: string; reply_count?: number }[]>(
    channels.map((c) => [c.id, []]),
  );
  const posted: { channel: string; text: string }[] = [];

  const call: SlackCall = async (method, params) => {
    switch (method) {
      case "conversations.list":
        return { ok: true, channels };
      case "conversations.join":
        joined.add(String(params.channel));
        return { ok: true };
      case "conversations.history": {
        if (!joined.has(String(params.channel))) {
          return { ok: false, error: "not_in_channel" };
        }
        const all = messages.get(String(params.channel)) ?? [];
        const oldest = String(params.oldest ?? "0");
        // parents and standalone messages only, newest first, after `oldest`
        const page = all.filter((m) => m.ts > oldest && (!m.thread_ts || m.thread_ts === m.ts));
        return { ok: true, messages: [...page].reverse() };
      }
      case "conversations.replies": {
        const all = messages.get(String(params.channel)) ?? [];
        const ts = String(params.ts);
        return {
          ok: true,
          messages: all.filter((m) => m.ts === ts || m.thread_ts === ts),
        };
      }
      case "chat.postMessage":
        posted.push({ channel: String(params.channel), text: String(params.text) });
        return { ok: true };
      case "users.list":
        return { ok: true, members };
      default:
        throw new Error(`fake slack: unhandled ${method}`);
    }
  };

  return { team, channels, messages, posted, joined, members, call };
}

describe.skipIf(!stackUp)("slack connector", () => {
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

  beforeAll(async () => {
    await applyMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  /** Slack ts within the backfill window: `offset` seconds after an hour ago. */
  const ts = (offset: number) => (Date.now() / 1000 - 3600 + offset).toFixed(6);

  it("collects thread-grouped artifacts, records consent, tracks cursors and growth", async () => {
    const fake = fakeSlack();
    const [pub, priv] = fake.channels;
    const tStandalone = ts(0);
    const tParent = ts(10);
    const tReply = ts(11);
    const tPrivate = ts(20);
    const tLate = ts(99);

    fake.messages.set(pub!.id, [
      { ts: tStandalone, user: "U1", text: "standalone message" },
      { ts: tParent, thread_ts: tParent, user: "U2", text: "thread parent", reply_count: 1 },
      { ts: tReply, thread_ts: tParent, user: "U3", text: "first reply" },
    ]);
    fake.messages.set(priv!.id, [{ ts: tPrivate, user: "U4", text: "private note" }]);

    // --- first sync: everything new ---
    queued.length = 0;
    const first = await syncSlack(deps, fake.call, { teamIds: [fake.team] });
    expect(first.channels).toBe(2);
    expect(first.artifacts).toBe(3); // standalone + thread + private standalone
    expect(queued.every((j) => j.kind === "normalize")).toBe(true);

    // consent notice posted exactly once, into the private channel only
    expect(fake.posted).toEqual([{ channel: priv!.id, text: expect.stringContaining("org") }]);

    // the bot auto-joined the public channel to read history
    expect(fake.joined.has(pub!.id)).toBe(true);

    // thread artifact contains the whole thread with metadata preserved
    const threadKey = `${fake.team}:${pub!.id}:${tParent}:${tReply}`;
    const [row] = await db
      .select()
      .from(tables.rawArtifacts)
      .where(eq(tables.rawArtifacts.sourceKey, threadKey));
    expect(row).toBeDefined();
    const envelope = await getRawArtifact(deps, row!.objectKey);
    expect((envelope.payload as { messages: unknown[] }).messages).toHaveLength(2);
    expect(envelope.sourceMeta.permissions).toMatchObject({ visibility: "public" });

    // --- second sync: nothing changed → no new artifacts, no second notice ---
    queued.length = 0;
    const second = await syncSlack(deps, fake.call, { teamIds: [fake.team] });
    expect(second.artifacts).toBe(0);
    expect(queued).toHaveLength(0);
    expect(fake.posted).toHaveLength(1);

    // --- a late reply lands in the existing thread (invisible to history) ---
    fake.messages.get(pub!.id)!.push({
      ts: tLate,
      thread_ts: tParent,
      user: "U5",
      text: "late reply",
    });
    const third = await syncSlack(deps, fake.call, { teamIds: [fake.team] });
    expect(third.artifacts).toBe(1); // re-captured thread revision

    const revisionKey = `${fake.team}:${pub!.id}:${tParent}:${tLate}`;
    const [revision] = await db
      .select()
      .from(tables.rawArtifacts)
      .where(eq(tables.rawArtifacts.sourceKey, revisionKey));
    expect(revision).toBeDefined();
    const grown = await getRawArtifact(deps, revision!.objectKey);
    expect((grown.payload as { messages: unknown[] }).messages).toHaveLength(3);

    // channel cursor advanced past everything visible in history
    const [chan] = await db
      .select()
      .from(tables.slackChannels)
      .where(eq(tables.slackChannels.id, pub!.id));
    expect(chan!.lastPulledTs).toBe(tParent);
  });

  it("links slack identities to existing people by email, never creating rows", async () => {
    const run = randomUUID().slice(0, 8);
    const [person] = await db
      .insert(tables.people)
      .values({ displayName: "Link Me", email: `link-${run}@example.com` })
      .returning({ id: tables.people.id });

    const fake = fakeSlack();
    fake.members.push(
      { id: `ULINK${run}`, real_name: "Link Me", profile: { email: `LINK-${run}@example.com` } }, // case-insensitive match
      { id: `UBOT${run}`, is_bot: true, real_name: "Bot", profile: { email: `bot-${run}@example.com` } },
      { id: `UGONE${run}`, deleted: true, real_name: "Gone", profile: { email: `gone-${run}@example.com` } },
      { id: `UNEW${run}`, real_name: "Stranger", profile: { email: `stranger-${run}@example.com` } }, // no person row
    );

    const before = await db.$count(tables.people);
    await syncSlack(deps, fake.call, { teamIds: [fake.team] });

    const [linked] = await db
      .select({ slackUserId: tables.people.slackUserId })
      .from(tables.people)
      .where(eq(tables.people.id, person!.id));
    expect(linked!.slackUserId).toBe(`ULINK${run}`);
    // Strangers, bots, and deleted accounts create nothing in the people directory.
    expect(await db.$count(tables.people)).toBe(before);

    const cached = await db
      .select({ id: tables.slackUsers.id, displayName: tables.slackUsers.displayName })
      .from(tables.slackUsers)
      .where(eq(tables.slackUsers.id, `UNEW${run}`));
    expect(cached).toEqual([{ id: `UNEW${run}`, displayName: "Stranger" }]);
    const bot = await db
      .select({ id: tables.slackUsers.id })
      .from(tables.slackUsers)
      .where(eq(tables.slackUsers.id, `UBOT${run}`));
    expect(bot).toHaveLength(0);
  });

  it("honors the channel allowlist", async () => {
    const fake = fakeSlack();
    fake.messages.set(fake.channels[0]!.id, [{ ts: ts(500), user: "U1", text: "hi" }]);
    fake.messages.set(fake.channels[1]!.id, [{ ts: ts(501), user: "U2", text: "yo" }]);

    const result = await syncSlack(deps, fake.call, {
      teamIds: [fake.team],
      channelAllowlist: [fake.channels[0]!.id],
    });
    expect(result.channels).toBe(1);
    expect(result.artifacts).toBe(1);
  });
});

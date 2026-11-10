/**
 * Slack connector (task 3.3): periodic pull of all public channels (and
 * opted-in private ones), thread-grouped into raw artifacts.
 *
 * Consent model (ingestion-pipeline spec): a private channel is collected only
 * while the bot is a member. The owner inviting @second-brain IS the opt-in; the
 * bot posts an org-visibility notice into the channel on first collection, and
 * removing the bot stops collection.
 *
 * Threads: `conversations.history` returns only parents and broadcasts, never
 * re-surfacing a parent when replies arrive. Threads seen recently (revisit
 * window) are therefore re-polled each sync; a grown thread is re-captured
 * whole under a new revision sourceKey `${team}:${channel}:${thread}:${latest}`.
 */
import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { slackProfileName, tables, type Job } from "@second-brain/schema";
import type { WorkerDeps } from "../lib/deps.ts";
import { putRawArtifact } from "../raw.ts";
import { paginate, type SlackCall } from "./slack-client.ts";

interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
}

interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
  subtype?: string;
}

export interface SlackSyncOptions {
  teamIds: string[];
  /** Restrict to specific channel IDs (dev/testing). */
  channelAllowlist?: string[];
  /** First-sync backfill horizon; full history arrives via task 7.4 replay. */
  backfillDays?: number;
  /** How long after its last activity a thread keeps being re-polled. */
  threadRevisitDays?: number;
  now?: Date;
}

const CONSENT_NOTICE =
  "This private channel is now collected by second-brain because the channel " +
  "owner opted in by adding this app. Extracted content becomes visible to " +
  "the whole org in the brain. Remove @second-brain from the channel to stop collection.";

interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { email?: string; display_name?: string; real_name?: string };
}

/**
 * Link Slack identities onto person rows by email (users:read.email) and
 * cache every human member's display name in slack_users. The people
 * directory of record is Google Workspace — this only annotates existing
 * rows (so the daily digest can DM them), never creates people. Unlinked
 * Slack users still get a name from the cache so prose doesn't keep the id.
 */
export async function syncSlackUsers(
  deps: WorkerDeps,
  call: SlackCall,
  teamId: string,
): Promise<{ linked: number }> {
  const members = await paginate<SlackUser>(call, "users.list", { team_id: teamId }, "members");
  const byEmail = new Map<string, string>();
  for (const m of members) {
    const email = m.profile?.email?.toLowerCase();
    if (!email || m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
    byEmail.set(email, m.id);
  }
  if (byEmail.size === 0 && members.length === 0) return { linked: 0 };

  const directory = members.flatMap((m) => {
    if (m.is_bot || m.id === "USLACKBOT") return [];
    const displayName = slackProfileName(m);
    return displayName ? [{ id: m.id, displayName }] : [];
  });
  if (directory.length > 0) {
    const existing = await deps.db
      .select({ id: tables.slackUsers.id, displayName: tables.slackUsers.displayName })
      .from(tables.slackUsers)
      .where(
        inArray(
          tables.slackUsers.id,
          directory.map((d) => d.id),
        ),
      );
    const known = new Map(existing.map((row) => [row.id, row.displayName]));
    for (const row of directory) {
      if (known.get(row.id) === row.displayName) continue;
      await deps.db
        .insert(tables.slackUsers)
        .values(row)
        .onConflictDoUpdate({
          target: tables.slackUsers.id,
          set: { displayName: row.displayName, updatedAt: new Date() },
        });
    }
  }

  const rows = await deps.db
    .select({
      id: tables.people.id,
      email: tables.people.email,
      slackUserId: tables.people.slackUserId,
    })
    .from(tables.people)
    .where(isNotNull(tables.people.email));

  let linked = 0;
  for (const person of rows) {
    const slackId = byEmail.get(person.email!.toLowerCase());
    if (!slackId || person.slackUserId === slackId) continue;
    try {
      await deps.db
        .update(tables.people)
        .set({ slackUserId: slackId, updatedAt: new Date() })
        .where(eq(tables.people.id, person.id));
      linked++;
    } catch (err) {
      // Unique violation: another person row already holds this Slack id
      // (duplicate identities are a data-hygiene problem, not a sync failure).
      deps.logger.warn({ err, personId: person.id, slackId }, "slack identity link skipped");
    }
  }
  return { linked };
}

const slackTs = (d: Date) => (d.getTime() / 1000).toFixed(6);

export async function syncSlack(
  deps: WorkerDeps,
  call: SlackCall,
  opts: SlackSyncOptions,
): Promise<{ channels: number; artifacts: number }> {
  const now = opts.now ?? new Date();
  const backfillFloor = slackTs(
    new Date(now.getTime() - (opts.backfillDays ?? 30) * 86_400_000),
  );
  const revisitFloor = slackTs(
    new Date(now.getTime() - (opts.threadRevisitDays ?? 7) * 86_400_000),
  );

  let channelCount = 0;
  let artifactCount = 0;

  for (const teamId of opts.teamIds) {
    // Identity linking rides the hourly sync; failure must not stall ingestion.
    try {
      const { linked } = await syncSlackUsers(deps, call, teamId);
      if (linked > 0) deps.logger.info({ teamId, linked }, "slack identities linked to people");
    } catch (err) {
      deps.logger.error({ err, teamId }, "slack user sync failed; continuing");
    }

    const channels = await paginate<SlackChannel>(
      call,
      "conversations.list",
      { team_id: teamId, types: "public_channel,private_channel", exclude_archived: true },
      "channels",
    );

    for (const channel of channels) {
      if (channel.is_archived) continue;
      // groups:read only lists private channels the bot is in, but be explicit:
      if (channel.is_private && channel.is_member === false) continue;
      if (opts.channelAllowlist && !opts.channelAllowlist.includes(channel.id)) continue;

      try {
        artifactCount += await syncChannel(deps, call, {
          teamId,
          channel,
          backfillFloor,
          revisitFloor,
          now,
        });
        channelCount++;
      } catch (err) {
        // One bad channel must not stall the rest; SQS retry covers transients.
        deps.logger.error({ err, channel: channel.id }, "channel sync failed; continuing");
      }
    }
  }

  return { channels: channelCount, artifacts: artifactCount };
}

async function syncChannel(
  deps: WorkerDeps,
  call: SlackCall,
  ctx: {
    teamId: string;
    channel: SlackChannel;
    backfillFloor: string;
    revisitFloor: string;
    now: Date;
  },
): Promise<number> {
  const { channel, teamId } = ctx;

  const [state] = await deps.db
    .select()
    .from(tables.slackChannels)
    .where(eq(tables.slackChannels.id, channel.id));

  await deps.db
    .insert(tables.slackChannels)
    .values({
      id: channel.id,
      teamId,
      name: channel.name,
      isPrivate: channel.is_private ?? false,
      optedInAt: channel.is_private ? ctx.now : null,
    })
    .onConflictDoUpdate({
      target: tables.slackChannels.id,
      set: { name: channel.name, lastSyncedAt: ctx.now },
    });

  // Explicit consent notice on first collection of a private channel.
  if (channel.is_private && !state?.consentNoticePostedAt) {
    await call("chat.postMessage", { channel: channel.id, text: CONSENT_NOTICE });
    await deps.db
      .update(tables.slackChannels)
      .set({ consentNoticePostedAt: ctx.now })
      .where(eq(tables.slackChannels.id, channel.id));
  }

  // Reading history requires membership even for public channels; the bot
  // auto-joins those (channels:join). Private membership is the opt-in (D7).
  if (!channel.is_private && channel.is_member === false) {
    await call("conversations.join", { channel: channel.id });
  }

  const oldest = state?.lastPulledTs ?? ctx.backfillFloor;
  const history = () =>
    paginate<SlackMessage>(
      call,
      "conversations.history",
      { channel: channel.id, oldest },
      "messages",
    );
  const newMessages = await history().catch(async (err: Error) => {
    if (channel.is_private || !err.message.includes("not_in_channel")) throw err;
    await call("conversations.join", { channel: channel.id });
    return history();
  });

  // Unit of extraction is the thread: new parents/broadcasts plus recent
  // threads that may have grown since their last capture.
  const threadKeys = new Set(newMessages.map((m) => m.thread_ts ?? m.ts));
  const recentThreads = await deps.db
    .select()
    .from(tables.slackThreads)
    .where(
      and(
        eq(tables.slackThreads.channelId, channel.id),
        gte(tables.slackThreads.threadTs, ctx.revisitFloor),
      ),
    );
  for (const t of recentThreads) threadKeys.add(t.threadTs);
  const collectedByThread = new Map(recentThreads.map((t) => [t.threadTs, t.latestCollectedTs]));

  const byTs = new Map(newMessages.map((m) => [m.ts, m]));
  let artifacts = 0;

  for (const threadTs of [...threadKeys].sort()) {
    const parent = byTs.get(threadTs);
    const standalone =
      parent && !parent.thread_ts && !parent.reply_count && !collectedByThread.has(threadTs);

    const thread: SlackMessage[] = standalone
      ? [parent]
      : await paginate<SlackMessage>(
          call,
          "conversations.replies",
          { channel: channel.id, ts: threadTs },
          "messages",
        );
    if (thread.length === 0) continue;

    const latest = thread.reduce((max, m) => (m.ts > max ? m.ts : max), threadTs);
    const already = collectedByThread.get(threadTs);
    if (already && already >= latest) continue; // no growth since last capture

    const { created } = await putRawArtifact(deps, {
      source: "slack",
      sourceKey: `${teamId}:${channel.id}:${threadTs}:${latest}`,
      payload: { teamId, channelId: channel.id, threadTs, messages: thread },
      sourceMeta: {
        permissions: { visibility: channel.is_private ? "private-opted-in" : "public", teamId },
        timestamps: { threadStartedTs: threadTs, latestMessageTs: latest },
        author: thread[0]?.user ?? thread[0]?.bot_id,
        channelName: channel.name,
        permalink: `https://app.slack.com/client/${teamId}/${channel.id}/thread/${channel.id}-${threadTs}`,
      },
    });

    await deps.db
      .insert(tables.slackThreads)
      .values({
        channelId: channel.id,
        threadTs,
        latestCollectedTs: latest,
        lastSeenAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [tables.slackThreads.channelId, tables.slackThreads.threadTs],
        set: { latestCollectedTs: latest, lastSeenAt: ctx.now },
      });

    if (created) {
      artifacts++;
      await deps.enqueue([
        {
          kind: "normalize",
          source: "slack",
          sourceKey: `${teamId}:${channel.id}:${threadTs}:${latest}`,
          payload: {},
          enqueuedAt: new Date().toISOString(),
        } satisfies Job,
      ]);
    }
  }

  const maxNewTs = newMessages.reduce((max, m) => (m.ts > max ? m.ts : max), oldest);
  await deps.db
    .update(tables.slackChannels)
    .set({ lastPulledTs: maxNewTs, lastSyncedAt: ctx.now })
    .where(eq(tables.slackChannels.id, channel.id));

  return artifacts;
}

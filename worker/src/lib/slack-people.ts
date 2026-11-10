/**
 * Resolve Slack user IDs to names for LLM-facing and stored text.
 *
 * Raw artifacts keep Slack IDs. Triage/extract rewrite authors and mentions
 * before the model sees them. people.displayName wins when slackUserId is
 * set; otherwise slack_users (filled by the Slack sync) supplies the name.
 * Unresolved ids stay as ids.
 */
import { inArray } from "drizzle-orm";
import {
  collectSlackIds,
  lookupSlackName,
  rewriteSlackIds,
  tables,
} from "@second-brain/schema";
import type { WorkerDeps } from "./deps.ts";

export { collectSlackIds, rewriteSlackIds } from "@second-brain/schema";

export interface SlackMsgLike {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

/** Slack user / enterprise-guest mention: <@U…> or <@U…|label>. */
const mentionPattern = () => /<@([UW][A-Za-z0-9]+)(?:\|[^>]*)?>/gi;

export function collectSlackUserIds(messages: SlackMsgLike[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.user) ids.add(m.user);
    for (const id of collectSlackIds(m.text ?? "")) ids.add(id);
    for (const match of (m.text ?? "").matchAll(mentionPattern())) ids.add(match[1]!);
  }
  return [...ids];
}

/** Replace <@U…> with @DisplayName when known; leave unresolved mentions intact. */
export function rewriteSlackMentions(text: string, names: Map<string, string>): string {
  return rewriteSlackIds(text, names, { atMentions: true });
}

export function formatSlackAuthor(
  m: Pick<SlackMsgLike, "user" | "bot_id">,
  names: Map<string, string>,
): string {
  if (m.bot_id) return "[bot]";
  const id = m.user ?? "unknown";
  return lookupSlackName(names, id) ?? id;
}

export function formatSlackLine(
  m: SlackMsgLike,
  names: Map<string, string>,
  opts?: { withTs?: boolean },
): string {
  const author = formatSlackAuthor(m, names);
  const text = rewriteSlackMentions(m.text ?? "", names);
  if (opts?.withTs && m.ts) return `[${m.ts}] ${author}: ${text}`;
  return `${author}: ${text}`;
}

export async function loadSlackDisplayNames(
  db: WorkerDeps["db"],
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  const [cached, people] = await Promise.all([
    db
      .select({
        id: tables.slackUsers.id,
        displayName: tables.slackUsers.displayName,
      })
      .from(tables.slackUsers)
      .where(inArray(tables.slackUsers.id, userIds)),
    db
      .select({
        slackUserId: tables.people.slackUserId,
        displayName: tables.people.displayName,
      })
      .from(tables.people)
      .where(inArray(tables.people.slackUserId, userIds)),
  ]);
  for (const row of cached) map.set(row.id, row.displayName);
  // Directory names win over the Slack profile when the person is linked.
  for (const row of people) {
    if (row.slackUserId) map.set(row.slackUserId, row.displayName);
  }
  return map;
}

/** One lookup for a batch of strings, then a pure rewriter. */
export async function slackRewriter(
  db: WorkerDeps["db"],
  texts: string[],
): Promise<(text: string) => string> {
  const ids = [...new Set(texts.flatMap((t) => collectSlackIds(t)))];
  const names = await loadSlackDisplayNames(db, ids);
  return (text) => rewriteSlackIds(text, names);
}

/** Format a Slack thread for triage/extract, resolving known people by slackUserId. */
export async function formatSlackMessagesForLlm(
  deps: Pick<WorkerDeps, "db">,
  messages: SlackMsgLike[],
  opts?: { withTs?: boolean },
): Promise<string> {
  const names = await loadSlackDisplayNames(deps.db, collectSlackUserIds(messages));
  return messages.map((m) => formatSlackLine(m, names, opts)).join("\n");
}

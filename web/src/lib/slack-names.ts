/**
 * Replace Slack user ids in text the app shows. Linked people use their
 * directory name; everyone else uses the Slack profile cached in slack_users.
 * Ids still missing are looked up once via users.info so already-written
 * events stop showing raw ids without waiting for the next sync.
 */
import { isNotNull } from "drizzle-orm";
import { collectSlackIds, rewriteSlackIds, slackProfileName, tables } from "@second-brain/schema";
import { db } from "./db";

const TEXT_KEYS = new Set([
  "title",
  "body",
  "summary",
  "snippet",
  "resolution",
  "detail",
  "answer",
  "description",
  "request",
  "bullets",
  "question",
]);

const LOOKUP_CAP = 25;

let cached: { at: number; map: Map<string, string> } | null = null;
const CACHE_MS = 60_000;
const resolved = new Map<string, string | null>();

async function directoryNames(): Promise<Map<string, string>> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.map;
  const [people, slackRows] = await Promise.all([
    db()
      .select({
        slackUserId: tables.people.slackUserId,
        displayName: tables.people.displayName,
      })
      .from(tables.people)
      .where(isNotNull(tables.people.slackUserId)),
    db()
      .select({ id: tables.slackUsers.id, displayName: tables.slackUsers.displayName })
      .from(tables.slackUsers),
  ]);
  const map = new Map<string, string>();
  for (const row of slackRows) map.set(row.id, row.displayName);
  for (const row of people) {
    if (row.slackUserId) map.set(row.slackUserId, row.displayName);
  }
  cached = { at: Date.now(), map };
  return map;
}

async function fetchSlackName(id: string): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  try {
    const body = new URLSearchParams({ user: id });
    const res = await fetch("https://slack.com/api/users.info", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      ok: boolean;
      user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
    };
    if (!data.ok || !data.user) return null;
    return slackProfileName(data.user);
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: "slack name lookup failed",
        id,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

async function remember(id: string, displayName: string): Promise<void> {
  cached?.map.set(id, displayName);
  await db()
    .insert(tables.slackUsers)
    .values({ id, displayName })
    .onConflictDoUpdate({
      target: tables.slackUsers.id,
      set: { displayName, updatedAt: new Date() },
    });
}

async function namesFor(texts: string[]): Promise<Map<string, string>> {
  const map = new Map(await directoryNames());
  const missing = [
    ...new Set(texts.flatMap((text) => collectSlackIds(text))),
  ].filter((id) => !map.has(id) && !map.has(id.toUpperCase()));
  await Promise.all(
    missing.slice(0, LOOKUP_CAP).map(async (id) => {
      if (resolved.has(id)) {
        const known = resolved.get(id);
        if (known) map.set(id, known);
        return;
      }
      const name = await fetchSlackName(id);
      resolved.set(id, name);
      if (!name) return;
      map.set(id, name);
      try {
        await remember(id, name);
      } catch (err) {
        console.warn(
          JSON.stringify({
            msg: "slack name cache write failed",
            id,
            err: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }),
  );
  return map;
}

function collectText(value: unknown, key: string | undefined, out: string[]): void {
  if (typeof value === "string") {
    if (key && TEXT_KEYS.has(key)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    if (key && TEXT_KEYS.has(key)) {
      for (const item of value) if (typeof item === "string") out.push(item);
      return;
    }
    for (const item of value) collectText(item, undefined, out);
    return;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) collectText(v, k, out);
  }
}

function humanizeTree<T>(value: T, names: Map<string, string>, key?: string): T {
  if (typeof value === "string") {
    return (key && TEXT_KEYS.has(key) ? rewriteSlackIds(value, names) : value) as T;
  }
  if (Array.isArray(value)) {
    if (key && TEXT_KEYS.has(key)) {
      return value.map((item) =>
        typeof item === "string" ? rewriteSlackIds(item, names) : humanizeTree(item, names),
      ) as T;
    }
    return value.map((item) => humanizeTree(item, names)) as T;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as object)) out[k] = humanizeTree(v, names, k);
    return out as T;
  }
  return value;
}

/** Rewrite Slack ids in the text fields of a query result. No-op when none are present. */
export async function presentSlackNames<T>(value: T): Promise<T> {
  const texts: string[] = [];
  collectText(value, undefined, texts);
  if (!texts.some((text) => collectSlackIds(text).length > 0)) return value;
  return humanizeTree(value, await namesFor(texts));
}

/** Rewrite a handful of strings (Jira issue text, and similar one-off writes). */
export async function presentSlackText(text: string): Promise<string> {
  if (collectSlackIds(text).length === 0) return text;
  const names = await namesFor([text]);
  return rewriteSlackIds(text, names);
}

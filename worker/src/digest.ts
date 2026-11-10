/**
 * Daily digest (task 5.9; web-app spec: Daily digest): one Slack DM per person
 * summarizing what the brain learned in the projects they own (POC / backup
 * POC) or follow — decisions, new blockers, status changes, and fresh
 * contradictions — with deep links back into the app.
 *
 * Delivery discipline: sending a DM is an external write, so the whole path
 * is opt-in (DIGEST_ENABLED) and allowlist-gated until the rollout
 * announcement (task 7.5). The scheduler claims one run per UTC day via a
 * connector_state marker; per-person "sent" markers make redelivered jobs
 * safe — nobody is DMed twice for the same day.
 *
 * Assembly is deterministic (no LLM): the digest quotes event titles the
 * extractor already wrote, so there is nothing new to hallucinate and no
 * token spend.
 */
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { tables } from "@second-brain/schema";
import type { SlackCall } from "./connectors/slack-client.ts";
import type { WorkerDeps } from "./lib/deps.ts";
import { slackRewriter } from "./lib/slack-people.ts";

/** Event types the digest surfaces (spec: decisions, new blockers, priority/status changes). */
const DIGEST_EVENT_TYPES = ["decision", "blocker_raised", "status_change"] as const;

const TYPE_LABEL: Record<(typeof DIGEST_EVENT_TYPES)[number], string> = {
  decision: "Decision",
  blocker_raised: "New blocker",
  status_change: "Status change",
};

const MAX_ITEMS_PER_PROJECT = 6;

export interface DigestOptions {
  /** Web app origin for deep links, e.g. https://xyz.awsapprunner.com */
  baseUrl: string;
  /** Lowercased emails; when set, only these people receive DMs (pre-rollout gate). */
  allowlist?: string[];
  /** Look-back window; default 24h to match the daily cadence. */
  windowMs?: number;
  now?: Date;
}

interface DigestItem {
  label: string;
  title: string;
  url: string;
}

const escapeMrkdwn = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const link = (url: string, text: string) => `<${url}|${escapeMrkdwn(text)}>`;

/**
 * One run per UTC day, claimed via connector_state so deploys and scheduler
 * ticks never double-send. Returns true exactly once per day, and only after
 * the configured send hour. Single worker in v1, so no claim race to guard.
 */
export async function claimDigestRun(
  deps: WorkerDeps,
  hourUtc: number,
  now = new Date(),
): Promise<boolean> {
  if (now.getUTCHours() < hourUtc) return false;
  const today = now.toISOString().slice(0, 10);
  const [row] = await deps.db
    .select()
    .from(tables.connectorState)
    .where(eq(tables.connectorState.key, "digest:lastRun"));
  if ((row?.value as { date?: string } | undefined)?.date === today) return false;
  await deps.db
    .insert(tables.connectorState)
    .values({ key: "digest:lastRun", value: { date: today } })
    .onConflictDoUpdate({
      target: tables.connectorState.key,
      set: { value: { date: today }, updatedAt: new Date() },
    });
  return true;
}

/** Owned (POC/backup) ∪ followed project ids per person. */
async function recipientProjectMap(deps: WorkerDeps): Promise<Map<string, Set<string>>> {
  const byPerson = new Map<string, Set<string>>();
  const add = (personId: string | null, projectId: string) => {
    if (!personId) return;
    let set = byPerson.get(personId);
    if (!set) byPerson.set(personId, (set = new Set()));
    set.add(projectId);
  };

  const projects = await deps.db
    .select({
      id: tables.projects.id,
      pocId: tables.projects.pocId,
      backupPocId: tables.projects.backupPocId,
    })
    .from(tables.projects);
  for (const p of projects) {
    add(p.pocId, p.id);
    add(p.backupPocId, p.id);
  }

  const follows = await deps.db
    .select({
      personId: tables.projectFollows.personId,
      projectId: tables.projectFollows.projectId,
    })
    .from(tables.projectFollows);
  for (const f of follows) add(f.personId, f.projectId);

  return byPerson;
}

function renderMessage(
  baseUrl: string,
  date: string,
  sections: { slug: string; name: string; items: DigestItem[] }[],
): string {
  const lines = [`*second-brain daily digest* — ${date}`];
  for (const s of sections) {
    lines.push("", `*${link(`${baseUrl}/projects/${encodeURIComponent(s.slug)}`, s.name)}*`);
    for (const item of s.items.slice(0, MAX_ITEMS_PER_PROJECT)) {
      lines.push(`• ${item.label}: ${link(item.url, item.title)}`);
    }
    const more = s.items.length - MAX_ITEMS_PER_PROJECT;
    if (more > 0) {
      lines.push(
        `• …and ${more} more — ${link(`${baseUrl}/projects/${encodeURIComponent(s.slug)}`, "open project")}`,
      );
    }
  }
  lines.push("", link(`${baseUrl}/activity`, "Open the activity feed"));
  return lines.join("\n");
}

/**
 * Send the daily digest DMs. Safe to re-run for the same day: per-person
 * markers skip anyone already messaged. Per-person send failures are logged
 * and skipped so one broken Slack id can't DLQ the whole run.
 */
export async function runDigest(
  deps: WorkerDeps,
  call: SlackCall,
  opts: DigestOptions,
): Promise<{ recipients: number; sent: number; skippedEmpty: number; failed: number }> {
  const now = opts.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - (opts.windowMs ?? 86_400_000));

  const byPerson = await recipientProjectMap(deps);
  if (byPerson.size === 0) return { recipients: 0, sent: 0, skippedEmpty: 0, failed: 0 };

  let people = await deps.db
    .select({
      id: tables.people.id,
      email: tables.people.email,
      slackUserId: tables.people.slackUserId,
    })
    .from(tables.people)
    .where(and(inArray(tables.people.id, [...byPerson.keys()]), eq(tables.people.active, true)));
  people = people.filter((p) => p.slackUserId);
  if (opts.allowlist) {
    people = people.filter((p) => p.email && opts.allowlist!.includes(p.email.toLowerCase()));
  }
  if (people.length === 0) return { recipients: 0, sent: 0, skippedEmpty: 0, failed: 0 };

  const projectIds = [...new Set(people.flatMap((p) => [...byPerson.get(p.id)!]))];

  const projectRows = await deps.db
    .select({ id: tables.projects.id, slug: tables.projects.slug, name: tables.projects.name })
    .from(tables.projects)
    .where(inArray(tables.projects.id, projectIds));
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  // Window on extractedAt: the digest covers what the brain *learned* since
  // yesterday, which may include older happenings surfacing late.
  const eventRows = await deps.db
    .select({
      id: tables.events.id,
      type: tables.events.type,
      title: tables.events.title,
      projectId: tables.eventProjects.projectId,
    })
    .from(tables.events)
    .innerJoin(tables.eventProjects, eq(tables.eventProjects.eventId, tables.events.id))
    .where(
      and(
        inArray(tables.eventProjects.projectId, projectIds),
        eq(tables.events.status, "active"),
        inArray(tables.events.type, [...DIGEST_EVENT_TYPES]),
        gte(tables.events.extractedAt, since),
      ),
    )
    .orderBy(tables.events.extractedAt);

  const contradictionRows = await deps.db
    .select({
      id: tables.contradictions.id,
      summary: tables.contradictions.summary,
      projectId: tables.contradictions.projectId,
    })
    .from(tables.contradictions)
    .where(
      and(
        or(
          inArray(tables.contradictions.projectId, projectIds),
          isNull(tables.contradictions.projectId),
        ),
        eq(tables.contradictions.status, "open"),
        gte(tables.contradictions.createdAt, since),
      ),
    );

  const itemsByProject = new Map<string, DigestItem[]>();
  const rewrite = await slackRewriter(deps.db, [
    ...eventRows.map((e) => e.title),
    ...contradictionRows.map((c) => c.summary),
  ]);
  const push = (projectId: string | null, item: DigestItem) => {
    if (!projectId) return;
    let list = itemsByProject.get(projectId);
    if (!list) itemsByProject.set(projectId, (list = []));
    list.push(item);
  };
  for (const e of eventRows) {
    const project = projectById.get(e.projectId);
    if (!project) continue;
    push(e.projectId, {
      label: TYPE_LABEL[e.type as (typeof DIGEST_EVENT_TYPES)[number]],
      title: rewrite(e.title),
      url: `${opts.baseUrl}/projects/${encodeURIComponent(project.slug)}#evt-${e.id}`,
    });
  }
  for (const c of contradictionRows) {
    const project = c.projectId ? projectById.get(c.projectId) : undefined;
    if (!project) continue;
    push(c.projectId, {
      label: "Contradiction",
      title: rewrite(c.summary),
      url: `${opts.baseUrl}/projects/${encodeURIComponent(project.slug)}`,
    });
  }

  let sent = 0;
  let skippedEmpty = 0;
  let failed = 0;
  for (const person of people) {
    const sections = [...byPerson.get(person.id)!]
      .map((projectId) => {
        const project = projectById.get(projectId);
        const items = itemsByProject.get(projectId) ?? [];
        return project && items.length > 0
          ? { slug: project.slug, name: project.name, items }
          : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (sections.length === 0) {
      skippedEmpty++;
      continue;
    }

    const sentKey = `digest:sent:${date}:${person.id}`;
    const [already] = await deps.db
      .select({ key: tables.connectorState.key })
      .from(tables.connectorState)
      .where(eq(tables.connectorState.key, sentKey));
    if (already) continue;

    try {
      await call("chat.postMessage", {
        channel: person.slackUserId!,
        text: renderMessage(opts.baseUrl, date, sections),
        unfurl_links: false,
        unfurl_media: false,
      });
      await deps.db
        .insert(tables.connectorState)
        .values({ key: sentKey, value: { sentAt: new Date().toISOString() } })
        .onConflictDoNothing();
      sent++;
    } catch (err) {
      failed++;
      deps.logger.error({ err, personId: person.id }, "digest DM failed; continuing");
    }
  }

  return { recipients: people.length, sent, skippedEmpty, failed };
}

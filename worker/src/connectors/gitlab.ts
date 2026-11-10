/**
 * GitLab connector (task 3.5): group webhooks land as collect jobs (via the
 * web endpoint) and an hourly reconciliation poll catches missed deliveries.
 * Both paths write raw artifacts; the normalize stage maps them straight to
 * work_items and typed events with no LLM (design D2 bypass), and issues feed
 * the GitLab→Jira sync (design D5).
 */
import { eq } from "drizzle-orm";
import { tables, type Job } from "@second-brain/schema";
import type { WorkerDeps } from "../lib/deps.ts";
import { putRawArtifact, type RawEnvelope } from "../raw.ts";

export type GitlabCall = (path: string) => Promise<{ body: unknown; nextPage?: string }>;

export function createGitlabClient(token: string, fetchImpl = fetch): GitlabCall {
  return async function call(path) {
    const res = await fetchImpl(`https://gitlab.com/api/v4${path}`, {
      headers: { "PRIVATE-TOKEN": token },
    });
    if (!res.ok) throw new Error(`gitlab GET ${path}: HTTP ${res.status}`);
    const nextPage = res.headers.get("x-next-page") || undefined;
    return { body: await res.json(), nextPage };
  };
}

/** Normalized shape shared by webhook payloads and REST items. */
export interface GitlabWorkItem {
  kind: "issue" | "merge_request";
  id: number;
  iid: number;
  projectPath: string;
  projectId: number;
  title: string;
  description: string | null;
  state: string;
  webUrl: string;
  authorUsername: string | null;
  labels: string[];
  assignees: string[];
  action?: string;
  updatedAt: string;
}

const GROUP = "exampleorg";
const CURSOR_KEY = "gitlab:reconcile-cursor";

async function getCursor(deps: WorkerDeps): Promise<string> {
  const [row] = await deps.db
    .select()
    .from(tables.connectorState)
    .where(eq(tables.connectorState.key, CURSOR_KEY));
  // No cursor = first run: start now, no historical backfill (that's task 7.4).
  return (row?.value as { updatedAfter?: string } | undefined)?.updatedAfter ??
    new Date().toISOString();
}

async function setCursor(deps: WorkerDeps, updatedAfter: string): Promise<void> {
  await deps.db
    .insert(tables.connectorState)
    .values({ key: CURSOR_KEY, value: { updatedAfter }, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: tables.connectorState.key,
      set: { value: { updatedAfter }, updatedAt: new Date() },
    });
}

/** Reconciliation poll: everything updated since the cursor, both item kinds. */
export async function syncGitlab(
  deps: WorkerDeps,
  call: GitlabCall,
): Promise<{ artifacts: number }> {
  const cursor = await getCursor(deps);
  let maxUpdated = cursor;
  let artifacts = 0;

  for (const [kind, path] of [
    ["issue", "issues"],
    ["merge_request", "merge_requests"],
  ] as const) {
    let page: string | undefined = "1";
    while (page) {
      const { body, nextPage } = await call(
        `/groups/${GROUP}/${path}?updated_after=${encodeURIComponent(cursor)}&scope=all&order_by=updated_at&sort=asc&per_page=100&page=${page}`,
      );
      for (const raw of body as Record<string, unknown>[]) {
        const item = fromRestItem(kind, raw);
        const { created } = await putRawArtifact(deps, {
          source: "gitlab",
          sourceKey: `gitlab:${kind}:${item.id}:${item.updatedAt}`,
          payload: { via: "reconciliation", kind, item: raw },
          sourceMeta: {
            permalink: item.webUrl,
            author: item.authorUsername,
            timestamps: { updatedAt: item.updatedAt },
            permissions: { projectPath: item.projectPath },
          },
        });
        if (created) {
          artifacts++;
          await deps.enqueue([
            {
              kind: "normalize",
              source: "gitlab",
              sourceKey: `gitlab:${kind}:${item.id}:${item.updatedAt}`,
              payload: {},
              enqueuedAt: new Date().toISOString(),
            } satisfies Job,
          ]);
        }
        if (item.updatedAt > maxUpdated) maxUpdated = item.updatedAt;
      }
      page = nextPage;
    }
  }

  await setCursor(deps, maxUpdated);
  return { artifacts };
}

function asStrings(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) =>
      typeof x === "string" ? x : ((x as Record<string, unknown>)?.[field] as string | undefined),
    )
    .filter((s): s is string => Boolean(s));
}

/** REST list item (reconciliation) → common shape. */
export function fromRestItem(
  kind: "issue" | "merge_request",
  raw: Record<string, unknown>,
): GitlabWorkItem {
  const refs = raw.references as { full?: string } | undefined;
  const projectPath = refs?.full?.split(/[#!]/)[0] ?? "";
  return {
    kind,
    id: raw.id as number,
    iid: raw.iid as number,
    projectPath,
    projectId: raw.project_id as number,
    title: raw.title as string,
    description: (raw.description as string | null) ?? null,
    state: raw.state as string,
    webUrl: raw.web_url as string,
    authorUsername: ((raw.author as Record<string, unknown>)?.username as string) ?? null,
    labels: asStrings(raw.labels, "name"),
    assignees: asStrings(raw.assignees, "username"),
    updatedAt: raw.updated_at as string,
  };
}

/** GitLab webhook timestamps look like "2026-09-05 12:00:00 UTC"; REST uses ISO. */
export function normalizeGitlabTs(s: string): string {
  return s.replace(" UTC", "Z").replace(" ", "T");
}

/** Webhook payload (issue/merge_request events) → common shape; null for other kinds. */
export function fromWebhook(payload: Record<string, unknown>): GitlabWorkItem | null {
  const kind = payload.object_kind as string;
  if (kind !== "issue" && kind !== "merge_request") return null;
  const attrs = payload.object_attributes as Record<string, unknown>;
  const project = payload.project as Record<string, unknown>;
  return {
    kind,
    id: attrs.id as number,
    iid: attrs.iid as number,
    projectPath: project.path_with_namespace as string,
    projectId: project.id as number,
    title: attrs.title as string,
    description: (attrs.description as string | null) ?? null,
    state: (attrs.state as string) ?? "opened",
    webUrl: attrs.url as string,
    authorUsername: ((payload.user as Record<string, unknown>)?.username as string) ?? null,
    labels: asStrings(payload.labels, "title"),
    assignees: asStrings(payload.assignees, "username"),
    action: attrs.action as string | undefined,
    updatedAt: normalizeGitlabTs((attrs.updated_at as string) ?? new Date().toISOString()),
  };
}

/** Extract the common shape from a stored raw artifact envelope. */
export function itemFromEnvelope(envelope: RawEnvelope): GitlabWorkItem | null {
  const payload = envelope.payload as Record<string, unknown>;
  if (payload.via === "reconciliation") {
    return fromRestItem(
      payload.kind as "issue" | "merge_request",
      payload.item as Record<string, unknown>,
    );
  }
  return fromWebhook(payload);
}

/**
 * LLM-bypass mapping: upsert the work_items mirror row and emit deterministic
 * status_change events (dedupe-keyed, replay-safe). Returns the item so the
 * caller can feed the Jira sync.
 */
export async function mapGitlabItem(
  deps: WorkerDeps,
  artifactId: string,
  item: GitlabWorkItem,
): Promise<{ workItemId: string; projectId: string | null }> {
  const [repo] = await deps.db
    .select()
    .from(tables.repos)
    .where(eq(tables.repos.gitlabProjectId, item.projectId));

  const reference = `${item.kind === "issue" ? "#" : "!"}${item.iid}`;
  const values = {
    source: "gitlab" as const,
    kind: item.kind,
    sourceId: String(item.id),
    reference,
    sourceProject: item.projectPath,
    repoId: repo?.id,
    projectId: repo?.projectId ?? null,
    title: item.title,
    state: item.state,
    webUrl: item.webUrl,
    authorUsername: item.authorUsername,
    labels: item.labels,
    assignees: item.assignees,
    sourceUpdatedAt: new Date(item.updatedAt),
    syncedAt: new Date(),
  };
  const [row] = await deps.db
    .insert(tables.workItems)
    .values(values)
    .onConflictDoUpdate({
      target: [tables.workItems.source, tables.workItems.kind, tables.workItems.sourceId],
      set: values,
    })
    .returning({ id: tables.workItems.id });

  // Deterministic events only where a brain project exists to link to.
  const projectId = repo?.projectId ?? null;
  if (projectId) {
    const eventFor =
      item.kind === "merge_request" && item.state === "merged"
        ? { title: `MR ${reference} merged: ${item.title}`, keyState: "merged" }
        : item.kind === "issue" && item.state === "closed"
          ? { title: `Issue ${reference} closed: ${item.title}`, keyState: "closed" }
          : item.kind === "issue" && item.action === "open"
            ? { title: `Issue ${reference} opened: ${item.title}`, keyState: "opened" }
            : null;
    if (eventFor) {
      const { createEvent } = await import("@second-brain/schema");
      await createEvent(deps.db, {
        type: "status_change",
        title: eventFor.title,
        confidence: 1,
        artifactId,
        projectIds: [projectId],
        permalink: item.webUrl,
        occurredAt: new Date(item.updatedAt),
        extractedBy: "gitlab-bypass",
        workItemId: row!.id,
        dedupeKey: `gitlab:${item.kind}:${item.id}:${eventFor.keyState}`,
      });
    }
  }

  return { workItemId: row!.id, projectId };
}

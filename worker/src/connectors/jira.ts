/**
 * Jira connector (task 3.6): polling mirror of the configured projects (the
 * system of record for issue tracking) plus the one-way idempotent
 * GitLab→Jira issue sync (design D5).
 *
 * Auth: scoped service-account token, Bearer-only, via the api.atlassian.com
 * gateway (site-URL basic auth does not work with these tokens).
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { tables, type Job } from "@second-brain/schema";
import type { WorkerDeps } from "../lib/deps.ts";
import { putRawArtifact, type RawEnvelope } from "../raw.ts";
import type { GitlabWorkItem } from "./gitlab.ts";

export interface JiraConfig {
  mirrorProjects: string[];
  syncMappings: { gitlabPrefix: string; jiraProject: string }[];
  catchAllProject: string;
  syncLabel: string;
  /** Root GitLab group stripped before prefix matching (falls back to GITLAB_ROOT_GROUP env). */
  rootGroup?: string;
}

export function loadJiraConfig(
  path = new URL("../../../config/jira-sync.json", import.meta.url).pathname,
): JiraConfig {
  return JSON.parse(readFileSync(path, "utf8")) as JiraConfig;
}

export type JiraCall = (
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
) => Promise<Record<string, unknown>>;

export function createJiraClient(token: string, cloudId: string, fetchImpl = fetch): JiraCall {
  return async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 5) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "5");
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (res.status === 204) return {};
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(`jira ${method} ${path}: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
      }
      return data;
    }
  };
}

const CURSOR_KEY = "jira:reconcile-cursor";

/** Poll the mirror projects for issues updated since the cursor. */
export async function syncJira(
  deps: WorkerDeps,
  call: JiraCall,
  config: JiraConfig,
): Promise<{ artifacts: number }> {
  const [row] = await deps.db
    .select()
    .from(tables.connectorState)
    .where(eq(tables.connectorState.key, CURSOR_KEY));
  // First run starts now — history arrives via deliberate backfill (7.4).
  const cursor =
    (row?.value as { updatedAfter?: string } | undefined)?.updatedAfter ?? new Date().toISOString();
  const cursorMs = Date.parse(cursor);
  let maxUpdatedMs = cursorMs;
  let artifacts = 0;

  // JQL "updated >=" takes minute precision; overlap a little and rely on
  // idempotent sourceKeys to drop duplicates.
  const jqlTime = new Date(cursorMs - 60_000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  const jql = `project in (${config.mirrorProjects.join(",")}) AND updated >= "${jqlTime}" ORDER BY updated ASC`;

  let nextPageToken: string | undefined;
  do {
    const page = await call(
      "GET",
      `/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${encodeURIComponent(
        "summary,description,status,statusCategory,updated,created,assignee,reporter,labels,issuetype,project",
      )}${nextPageToken ? `&nextPageToken=${encodeURIComponent(nextPageToken)}` : ""}`,
    );
    for (const issue of (page.issues as Record<string, unknown>[] | undefined) ?? []) {
      const fields = issue.fields as Record<string, unknown>;
      const updated = fields.updated as string;
      const updatedMs = Date.parse(updated);
      const key = issue.key as string;
      const { created } = await putRawArtifact(deps, {
        source: "jira",
        sourceKey: `jira:${key}:${updated}`,
        payload: { key, fields },
        sourceMeta: {
          permalink: `${process.env.JIRA_BASE_URL ?? "https://example.atlassian.net"}/browse/${key}`,
          author: (fields.reporter as Record<string, unknown>)?.displayName,
          timestamps: { updatedAt: updated },
          permissions: { jiraProject: (fields.project as Record<string, unknown>)?.key },
        },
      });
      if (created) {
        artifacts++;
        await deps.enqueue([
          {
            kind: "normalize",
            source: "jira",
            sourceKey: `jira:${key}:${updated}`,
            payload: {},
            enqueuedAt: new Date().toISOString(),
          } satisfies Job,
        ]);
      }
      if (updatedMs > maxUpdatedMs) maxUpdatedMs = updatedMs;
    }
    nextPageToken = page.nextPageToken as string | undefined;
  } while (nextPageToken);

  const newCursor = new Date(maxUpdatedMs).toISOString();
  await deps.db
    .insert(tables.connectorState)
    .values({ key: CURSOR_KEY, value: { updatedAfter: newCursor }, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: tables.connectorState.key,
      set: { value: { updatedAfter: newCursor }, updatedAt: new Date() },
    });

  return { artifacts };
}

/** Mirror mapping: raw Jira artifact → work_items upsert. */
export async function mapJiraArtifact(deps: WorkerDeps, envelope: RawEnvelope): Promise<void> {
  const { key, fields } = envelope.payload as {
    key: string;
    fields: Record<string, unknown>;
  };
  const issueType = ((fields.issuetype as Record<string, unknown>)?.name as string) ?? "Task";
  const projectKey = ((fields.project as Record<string, unknown>)?.key as string) ?? "";
  const baseUrl = process.env.JIRA_BASE_URL ?? "https://example.atlassian.net";

  // Brain-project linkage: reverse the sync mapping where it's unambiguous
  // (a 2-segment gitlabPrefix is a project slug; team-level prefixes are not).
  const config = loadJiraConfig();
  const mapping = config.syncMappings.find((m) => m.jiraProject === projectKey);
  let projectId: string | null = null;
  if (mapping && mapping.gitlabPrefix.includes("/")) {
    const [proj] = await deps.db
      .select({ id: tables.projects.id })
      .from(tables.projects)
      .where(eq(tables.projects.slug, mapping.gitlabPrefix));
    projectId = proj?.id ?? null;
  }

  // Status display names are localized per account language; statusCategory
  // keys (new/indeterminate/done) are stable and locale-independent.
  const status = fields.status as
    | { name?: string; statusCategory?: { key?: string } }
    | undefined;
  const values = {
    source: "jira" as const,
    kind: issueType.toLowerCase() === "epic" ? ("epic" as const) : ("issue" as const),
    sourceId: key,
    reference: key,
    sourceProject: projectKey,
    projectId,
    title: (fields.summary as string) ?? key,
    state: status?.statusCategory?.key ?? status?.name ?? "unknown",
    webUrl: `${baseUrl}/browse/${key}`,
    authorUsername: ((fields.reporter as Record<string, unknown>)?.displayName as string) ?? null,
    labels: (fields.labels as string[]) ?? [],
    assignees: fields.assignee
      ? [((fields.assignee as Record<string, unknown>).displayName as string) ?? ""]
      : [],
    sourceUpdatedAt: new Date(fields.updated as string),
    syncedAt: new Date(),
  };
  await deps.db
    .insert(tables.workItems)
    .values(values)
    .onConflictDoUpdate({
      target: [tables.workItems.source, tables.workItems.kind, tables.workItems.sourceId],
      set: values,
    });
}

/** Longest-prefix match of a GitLab path (without the root group) to a Jira project. */
export function jiraProjectFor(config: JiraConfig, gitlabProjectPath: string): string {
  const root = config.rootGroup ?? process.env.GITLAB_ROOT_GROUP ?? "";
  const path = root ? gitlabProjectPath.replace(new RegExp(`^${root}/`), "") : gitlabProjectPath;
  let best: { len: number; project: string } | null = null;
  for (const m of config.syncMappings) {
    if (path === m.gitlabPrefix || path.startsWith(`${m.gitlabPrefix}/`)) {
      if (!best || m.gitlabPrefix.length > best.len) {
        best = { len: m.gitlabPrefix.length, project: m.jiraProject };
      }
    }
  }
  return best?.project ?? config.catchAllProject;
}

/** Minimal Atlassian Document Format for the counterpart description. */
function adf(text: string, gitlabUrl: string) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Synced from GitLab: " },
          {
            type: "text",
            text: gitlabUrl,
            marks: [{ type: "link", attrs: { href: gitlabUrl } }],
          },
        ],
      },
      ...(text
        ? [{ type: "paragraph", content: [{ type: "text", text: text.slice(0, 30_000) }] }]
        : []),
    ],
  };
}

/**
 * One-way GitLab→Jira sync (design D5): ensure the GitLab issue has an
 * up-to-date Jira counterpart. Loop-safe via the jira_sync_links registry —
 * webhook replays and reconciliation re-reads are no-ops.
 */
export async function ensureJiraCounterpart(
  deps: WorkerDeps,
  call: JiraCall,
  config: JiraConfig,
  item: GitlabWorkItem,
): Promise<{ jiraKey: string; action: "created" | "updated" | "unchanged" }> {
  const [link] = await deps.db
    .select()
    .from(tables.jiraSyncLinks)
    .where(eq(tables.jiraSyncLinks.gitlabIssueId, item.id));

  const updatedAt = new Date(item.updatedAt);
  if (link && link.gitlabUpdatedAt && link.gitlabUpdatedAt >= updatedAt) {
    return { jiraKey: link.jiraKey, action: "unchanged" };
  }

  if (link) {
    await call("PUT", `/issue/${link.jiraKey}`, {
      fields: {
        summary: item.title,
        description: adf(item.description ?? "", item.webUrl),
      },
    });
    await deps.db
      .update(tables.jiraSyncLinks)
      .set({ gitlabUpdatedAt: updatedAt, lastSyncedAt: new Date() })
      .where(eq(tables.jiraSyncLinks.gitlabIssueId, item.id));
    return { jiraKey: link.jiraKey, action: "updated" };
  }

  const target = jiraProjectFor(config, item.projectPath);
  const created = await call("POST", "/issue", {
    fields: {
      project: { key: target },
      issuetype: { name: "Task" },
      summary: item.title,
      description: adf(item.description ?? "", item.webUrl),
      labels: [config.syncLabel],
    },
  });
  const jiraKey = created.key as string;

  // Cross-link on the Jira side (GitLab side deferred until after the org
  // ingestion announcement — no bot comments in team projects yet).
  await call("POST", `/issue/${jiraKey}/remotelink`, {
    object: { url: item.webUrl, title: `GitLab ${item.projectPath}#${item.iid}` },
  });

  await deps.db.insert(tables.jiraSyncLinks).values({
    gitlabIssueId: item.id,
    gitlabProjectPath: item.projectPath,
    gitlabIssueUrl: item.webUrl,
    jiraKey,
    gitlabUpdatedAt: updatedAt,
  });

  return { jiraKey, action: "created" };
}

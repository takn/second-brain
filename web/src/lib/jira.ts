/**
 * Web-side Jira writer for one-click issue creation from untracked work
 * (web-app spec, task 5.8). Same Bearer/api.atlassian.com auth as the worker
 * connector; kept tiny — one create call — rather than sharing the whole
 * connector module across packages.
 */
import { readFileSync } from "node:fs";

export interface JiraSyncConfig {
  syncMappings: { gitlabPrefix: string; jiraProject: string }[];
  catchAllProject: string;
}

let cachedConfig: JiraSyncConfig | null = null;

/** The sync mapping ships at config/jira-sync.json; cwd differs dev vs standalone image. */
export function jiraSyncConfig(): JiraSyncConfig {
  if (cachedConfig) return cachedConfig;
  const candidates = [
    process.env.JIRA_SYNC_CONFIG,
    "config/jira-sync.json",
    "../config/jira-sync.json",
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    try {
      cachedConfig = JSON.parse(readFileSync(path, "utf8")) as JiraSyncConfig;
      return cachedConfig;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("jira-sync.json not found (set JIRA_SYNC_CONFIG)");
}

/** Longest-prefix match of a brain project slug to its Jira project key. */
export function jiraProjectForSlug(config: JiraSyncConfig, slug: string): string {
  let best: { len: number; project: string } | null = null;
  for (const m of config.syncMappings) {
    if (slug === m.gitlabPrefix || slug.startsWith(`${m.gitlabPrefix}/`)) {
      if (!best || m.gitlabPrefix.length > best.len) {
        best = { len: m.gitlabPrefix.length, project: m.jiraProject };
      }
    }
  }
  return best?.project ?? config.catchAllProject;
}

export interface CreatedIssue {
  key: string;
  webUrl: string;
}

export async function createJiraIssue(input: {
  projectKey: string;
  summary: string;
  description: string;
  labels?: string[];
}): Promise<CreatedIssue> {
  const token = process.env.JIRA_API_TOKEN;
  const cloudId = process.env.JIRA_CLOUD_ID;
  if (!token || !cloudId) throw new Error("jira credentials not configured");
  const baseUrl = process.env.JIRA_BASE_URL ?? "https://example.atlassian.net";

  const res = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: input.projectKey },
        issuetype: { name: "Task" },
        summary: input.summary,
        labels: input.labels ?? [],
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: input.description }] },
          ],
        },
      },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { key?: string };
  if (!res.ok || !data.key) {
    throw new Error(`jira issue create failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { key: data.key, webUrl: `${baseUrl}/browse/${data.key}` };
}

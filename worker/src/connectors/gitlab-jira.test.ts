import { randomUUID } from "node:crypto";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { applyMigrations, tables, type Job } from "@second-brain/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Client, type WorkerDeps } from "../lib/deps.ts";
import { fromWebhook, mapGitlabItem, syncGitlab, type GitlabCall } from "./gitlab.ts";
import {
  ensureJiraCounterpart,
  jiraProjectFor,
  mapJiraArtifact,
  syncJira,
  type JiraCall,
  type JiraConfig,
} from "./jira.ts";
import { getRawArtifact } from "../raw.ts";

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

const testConfig: JiraConfig = {
  mirrorProjects: ["INFRA", "EX"],
  syncMappings: [
    { gitlabPrefix: "infrastructure-and-services/infrastructure-services", jiraProject: "INFRA" },
    { gitlabPrefix: "operations", jiraProject: "EXOPS" },
  ],
  catchAllProject: "EX",
  syncLabel: "gitlab-sync",
  rootGroup: "exampleorg",
};

/** Records Jira writes; serves canned reads. */
function fakeJira() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let issueCounter = Math.floor(Math.random() * 1e9);
  const searchPages: Record<string, unknown>[] = [];
  const call: JiraCall = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/issue") {
      return { key: `FAKE-${++issueCounter}` };
    }
    if (method === "GET" && path.startsWith("/search/jql")) {
      return searchPages.shift() ?? { issues: [] };
    }
    return {};
  };
  return { calls, searchPages, call };
}

describe.skipIf(!stackUp)("gitlab connector + jira sync", () => {
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

  const gitlabProjectId = Math.floor(Math.random() * 1e9);
  const webhookIssueId = Math.floor(Math.random() * 1e9);
  const projectPath = `exampleorg/infrastructure-and-services/infrastructure-services/testrepo-${randomUUID().slice(0, 8)}`;
  let projectId: string;

  beforeAll(async () => {
    await applyMigrations(sql);
    const [team] = await db
      .insert(tables.teams)
      .values({ slug: `t-${randomUUID().slice(0, 8)}`, name: "Infra" })
      .returning();
    const [project] = await db
      .insert(tables.projects)
      .values({ slug: `p-${randomUUID().slice(0, 8)}`, name: "Infra Services", teamId: team!.id })
      .returning();
    projectId = project!.id;
    await db.insert(tables.repos).values({
      gitlabProjectId,
      path: projectPath,
      name: "testrepo",
      projectId,
      webUrl: `https://gitlab.com/${projectPath}`,
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  function webhookIssue(overrides: Record<string, unknown> = {}) {
    return fromWebhook({
      object_kind: "issue",
      user: { username: "nelson" },
      project: { id: gitlabProjectId, path_with_namespace: projectPath },
      labels: [{ title: "bug" }],
      assignees: [{ username: "sam" }],
      object_attributes: {
        id: webhookIssueId,
        iid: 7,
        title: "Fix the flux capacitor",
        description: "It fluxes wrong",
        state: "opened",
        action: "open",
        url: `https://gitlab.com/${projectPath}/-/issues/7`,
        updated_at: "2026-09-05 12:00:00 UTC",
        ...overrides,
      },
    })!;
  }

  it("maps gitlab items to work_items with repo/project linkage and dedupe-keyed events", async () => {
    const item = webhookIssue();
    // synthetic raw artifact for provenance
    const [artifact] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "gitlab", sourceKey: `t:${randomUUID()}`, objectKey: "raw/gitlab/x.json" })
      .returning();

    const first = await mapGitlabItem(deps, artifact!.id, item);
    expect(first.projectId).toBe(projectId);

    const [row] = await db
      .select()
      .from(tables.workItems)
      .where(
        and(
          eq(tables.workItems.source, "gitlab"),
          eq(tables.workItems.sourceId, String(webhookIssueId)),
        ),
      );
    expect(row).toMatchObject({ kind: "issue", reference: "#7", state: "opened", projectId });

    // opened-issue event exists once, even after replay
    await mapGitlabItem(deps, artifact!.id, item);
    const events = await db
      .select()
      .from(tables.events)
      .where(eq(tables.events.dedupeKey, `gitlab:issue:${webhookIssueId}:opened`));
    expect(events).toHaveLength(1);
    expect(events[0]!.extractedBy).toBe("gitlab-bypass");

    // state change → mirror row updated in place
    const closed = webhookIssue({ state: "closed", action: "close", updated_at: "2026-09-05 13:00:00 UTC" });
    await mapGitlabItem(deps, artifact!.id, closed);
    const [after] = await db
      .select()
      .from(tables.workItems)
      .where(
        and(
          eq(tables.workItems.source, "gitlab"),
          eq(tables.workItems.sourceId, String(webhookIssueId)),
        ),
      );
    expect(after!.state).toBe("closed");
  });

  it("syncs gitlab issues to jira: create once, update on change, replay-safe", async () => {
    const jira = fakeJira();
    const item = webhookIssue();

    const created = await ensureJiraCounterpart(deps, jira.call, testConfig, item);
    expect(created.action).toBe("created");
    // mapped by longest prefix, not catch-all
    const createCall = jira.calls.find((c) => c.method === "POST" && c.path === "/issue");
    expect((createCall!.body as { fields: { project: { key: string } } }).fields.project.key).toBe(
      "INFRA",
    );
    expect(
      (createCall!.body as { fields: { labels: string[] } }).fields.labels,
    ).toContain("gitlab-sync");
    // cross-link posted
    expect(jira.calls.some((c) => c.path === `/issue/${created.jiraKey}/remotelink`)).toBe(true);

    // replay of the same state → no jira writes
    jira.calls.length = 0;
    const replay = await ensureJiraCounterpart(deps, jira.call, testConfig, item);
    expect(replay.action).toBe("unchanged");
    expect(jira.calls).toHaveLength(0);

    // newer gitlab state → PUT update, no second create
    const changed = webhookIssue({ title: "Fix it faster", updated_at: "2026-09-05 14:00:00 UTC" });
    const updated = await ensureJiraCounterpart(deps, jira.call, testConfig, changed);
    expect(updated.action).toBe("updated");
    expect(updated.jiraKey).toBe(created.jiraKey);
    expect(jira.calls.filter((c) => c.method === "POST" && c.path === "/issue")).toHaveLength(0);
  });

  it("routes unmapped paths to the catch-all", () => {
    expect(jiraProjectFor(testConfig, "exampleorg/modcon/sim/somerepo")).toBe("EX");
    expect(jiraProjectFor(testConfig, "exampleorg/operations/cloud-administration/x")).toBe("EXOPS");
    expect(
      jiraProjectFor(testConfig, "exampleorg/infrastructure-and-services/infrastructure-services/y"),
    ).toBe("INFRA");
  });

  it("reconciliation poll collects updated items and advances the cursor", async () => {
    const issueId = Math.floor(Math.random() * 1e9);
    const fixedUpdatedAt = new Date().toISOString();
    const gitlab: GitlabCall = async (path) => {
      if (path.includes("/issues?")) {
        return {
          body: [
            {
              id: issueId,
              iid: 3,
              title: "Reconciled issue",
              description: null,
              state: "opened",
              web_url: `https://gitlab.com/${projectPath}/-/issues/3`,
              references: { full: `${projectPath}#3` },
              project_id: gitlabProjectId,
              author: { username: "sam" },
              labels: ["ops"],
              assignees: [],
              updated_at: fixedUpdatedAt,
            },
          ],
        };
      }
      return { body: [] };
    };

    queued.length = 0;
    const first = await syncGitlab(deps, gitlab);
    expect(first.artifacts).toBe(1);
    expect(queued.map((j) => j.kind)).toEqual(["normalize"]);

    // artifact envelope round-trips
    const [row] = await db
      .select()
      .from(tables.rawArtifacts)
      .where(eq(tables.rawArtifacts.sourceKey, queued[0]!.sourceKey!));
    const envelope = await getRawArtifact(deps, row!.objectKey);
    expect((envelope.payload as { via: string }).via).toBe("reconciliation");

    // same item again → deduped by sourceKey
    const second = await syncGitlab(deps, gitlab);
    expect(second.artifacts).toBe(0);
  });

  it("mirrors jira issues via polling into work_items", async () => {
    const jira = fakeJira();
    const key = `INFRA-${Math.floor(Math.random() * 1e6)}`;
    jira.searchPages.push({
      issues: [
        {
          key,
          fields: {
            summary: "Provision the cluster",
            status: { name: "进行中", statusCategory: { key: "indeterminate" } },
            updated: new Date().toISOString(),
            reporter: { displayName: "Nelson A" },
            assignee: { displayName: "Sam P" },
            labels: ["infra"],
            issuetype: { name: "Task" },
            project: { key: "INFRA" },
          },
        },
      ],
    });

    queued.length = 0;
    const result = await syncJira(deps, jira.call, testConfig);
    expect(result.artifacts).toBe(1);
    expect(queued[0]!.kind).toBe("normalize");

    const [row] = await db
      .select()
      .from(tables.rawArtifacts)
      .where(eq(tables.rawArtifacts.sourceKey, queued[0]!.sourceKey!));
    const envelope = await getRawArtifact(deps, row!.objectKey);
    await mapJiraArtifact(deps, envelope);

    const [item] = await db
      .select()
      .from(tables.workItems)
      .where(and(eq(tables.workItems.source, "jira"), eq(tables.workItems.sourceId, key)));
    expect(item).toMatchObject({
      kind: "issue",
      reference: key,
      sourceProject: "INFRA",
      state: "indeterminate", // locale-stable statusCategory, not the display name
      title: "Provision the cluster",
    });

    // replay-safe upsert
    await mapJiraArtifact(deps, envelope);
    const rows = await db
      .select()
      .from(tables.workItems)
      .where(and(eq(tables.workItems.source, "jira"), eq(tables.workItems.sourceId, key)));
    expect(rows).toHaveLength(1);
  });
});

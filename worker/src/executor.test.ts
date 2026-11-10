import { randomUUID } from "node:crypto";
import { applyMigrations, tables } from "@second-brain/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Client, type WorkerDeps } from "./lib/deps.ts";
import { executeNamedAction, type ExecutorClients } from "./executor.ts";

const dbUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://brain:brain@localhost:54321/brain";

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

describe.skipIf(!stackUp)("executor", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });

  function makeDeps(): WorkerDeps {
    return {
      db,
      s3: createS3Client({
        S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000",
        S3_REGION: "us-east-1",
      } as NodeJS.ProcessEnv),
      bucket: process.env.S3_BUCKET_RAW ?? "second-brain-raw",
      enqueue: () => {},
      logger: pino({ level: "silent" }),
    };
  }

  beforeAll(async () => {
    await applyMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  it("refuses out-of-scope actions and audits the attempt", async () => {
    const deps = makeDeps();
    const clients: ExecutorClients = { dryRun: true };
    const result = await executeNamedAction(deps, clients, {
      actionName: "jira.delete_project",
      title: "nope",
      body: "nope",
      destination: {},
    });
    expect(result.allowed).toBe(false);
    expect(result.ok).toBe(false);

    const [audit] = await deps.db
      .select()
      .from(tables.executorAudit)
      .where(eq(tables.executorAudit.actionName, "jira.delete_project"))
      .orderBy(tables.executorAudit.createdAt);
    // latest row for this name — at least one refusal exists
    const rows = await deps.db
      .select()
      .from(tables.executorAudit)
      .where(eq(tables.executorAudit.actionName, "jira.delete_project"));
    expect(rows.some((r) => r.allowed === false)).toBe(true);
    expect(audit).toBeTruthy();
  });

  it("dry-runs scoped slack and jira actions without credentials", async () => {
    const deps = makeDeps();
    const clients: ExecutorClients = { dryRun: true };

    const slack = await executeNamedAction(deps, clients, {
      actionName: "slack.post_message",
      title: "ping",
      body: "hello team",
      destination: { slackChannel: "C123" },
    });
    expect(slack.allowed).toBe(true);
    expect(slack.ok).toBe(true);
    expect(slack.result.dryRun).toBe(true);

    const jira = await executeNamedAction(deps, clients, {
      actionName: "jira.create_issue",
      title: "Follow up",
      body: "details",
      destination: { jiraProjectKey: "EX" },
    });
    expect(jira.allowed).toBe(true);
    expect(jira.ok).toBe(true);
    expect(jira.result.projectKey).toBe("EX");
  });

  it("approves documents without external I/O", async () => {
    const deps = makeDeps();
    const result = await executeNamedAction(deps, {}, {
      actionName: "document.approve",
      title: `Brief ${randomUUID().slice(0, 8)}`,
      body: "# Status\n\nAll clear.",
      destination: {},
    });
    expect(result.allowed).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("sends email via injected client when EMAIL path is configured", async () => {
    const deps = makeDeps();
    const sent: { to: string[]; subject: string }[] = [];
    const result = await executeNamedAction(
      deps,
      {
        email: async ({ to, subject, body }) => {
          sent.push({ to, subject });
          expect(body).toContain("hello");
          return { messageId: "ses-test-id" };
        },
      },
      {
        actionName: "email.send",
        title: "Hello",
        body: "hello from the executor",
        destination: { emailTo: ["ops@test.example"], emailSubject: "Ping" },
      },
    );
    expect(result.ok).toBe(true);
    expect(sent).toEqual([{ to: ["ops@test.example"], subject: "Ping" }]);
  });
});

import { randomUUID } from "node:crypto";
import { applyMigrations, createEvent, createNarrativeRevision, tables } from "@second-brain/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Client, type WorkerDeps } from "./lib/deps.ts";
import type { Llm, LlmResponse } from "./lib/llm.ts";
import { lintAll } from "./linter.ts";

const dbUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://brain:brain@localhost:54321/brain";
const s3Env = {
  S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000",
  S3_REGION: "us-east-1",
} as NodeJS.ProcessEnv;

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

describe.skipIf(!stackUp)("linter", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  let projectId: string;
  let artifactId: string;

  function makeDeps(llm?: Llm): WorkerDeps {
    return {
      db,
      s3: createS3Client(s3Env),
      bucket: "second-brain-raw",
      enqueue: () => {},
      logger: pino({ level: "silent" }),
      llm,
    };
  }

  async function findingByKey(key: string) {
    const [row] = await db
      .select()
      .from(tables.lintFindings)
      .where(eq(tables.lintFindings.dedupeKey, key));
    return row;
  }

  beforeAll(async () => {
    await applyMigrations(sql);
    const [project] = await db
      .insert(tables.projects)
      .values({
        slug: `lint-${randomUUID().slice(0, 8)}`,
        name: "Lint Test Project",
        // Real-team marker so the POC-less orphan check applies to it.
        gitlabGroupId: Math.floor(Math.random() * 1_000_000_000),
      })
      .returning();
    projectId = project!.id;
    const [artifact] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "slack", sourceKey: `lint:${randomUUID()}`, objectKey: "raw/lint.json" })
      .returning();
    artifactId = artifact!.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("flags a stale blocker, then auto-resolves it once superseded", async () => {
    const { eventId } = await createEvent(db, {
      type: "blocker_raised",
      title: "Blocked on vendor API access",
      confidence: 0.9,
      artifactId,
      projectIds: [projectId],
    });
    await db
      .update(tables.events)
      .set({ extractedAt: new Date(Date.now() - 20 * 86_400_000) })
      .where(eq(tables.events.id, eventId));

    await lintAll(makeDeps());
    const finding = await findingByKey(`stale_event:${eventId}`);
    expect(finding).toBeDefined();
    expect(finding!.status).toBe("open");
    expect(finding!.projectId).toBe(projectId);

    // Re-run: refreshed, not duplicated.
    const firstSeen = finding!.lastSeenAt;
    await lintAll(makeDeps());
    const again = await findingByKey(`stale_event:${eventId}`);
    expect(again!.id).toBe(finding!.id);
    expect(again!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(firstSeen.getTime());

    // Condition clears (blocker superseded) → auto-resolved on the next pass.
    await db.update(tables.events).set({ status: "superseded" }).where(eq(tables.events.id, eventId));
    await lintAll(makeDeps());
    const resolved = await findingByKey(`stale_event:${eventId}`);
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolvedAt).not.toBeNull();
  });

  it("flags gitlab↔jira sync drift on state mismatch and resolves when states align", async () => {
    const gitlabIssueId = Math.floor(Math.random() * 1_000_000_000);
    const jiraKey = `LNT-${Math.floor(Math.random() * 100000)}`;
    await db.insert(tables.jiraSyncLinks).values({
      gitlabIssueId,
      gitlabProjectPath: "exampleorg/lint/test",
      gitlabIssueUrl: `https://gitlab.com/exampleorg/lint/test/-/issues/${gitlabIssueId}`,
      jiraKey,
    });
    const [gl] = await db
      .insert(tables.workItems)
      .values({
        source: "gitlab",
        kind: "issue",
        sourceId: String(gitlabIssueId),
        projectId,
        title: "Drifted issue",
        state: "closed",
        webUrl: `https://gitlab.com/exampleorg/lint/test/-/issues/${gitlabIssueId}`,
      })
      .returning();
    await db.insert(tables.workItems).values({
      source: "jira",
      kind: "issue",
      sourceId: jiraKey,
      reference: jiraKey,
      title: "Drifted issue",
      state: "new",
      webUrl: `https://example.atlassian.net/browse/${jiraKey}`,
    });

    await lintAll(makeDeps());
    const finding = await findingByKey(`sync_drift:${jiraKey}`);
    expect(finding).toBeDefined();
    expect(finding!.status).toBe("open");
    expect(finding!.summary).toContain(jiraKey);

    // Jira catches up → drift clears.
    await db
      .update(tables.workItems)
      .set({ state: "done" })
      .where(and(eq(tables.workItems.source, "jira"), eq(tables.workItems.sourceId, jiraKey)));
    await lintAll(makeDeps());
    const resolved = await findingByKey(`sync_drift:${jiraKey}`);
    expect(resolved!.status).toBe("resolved");
    expect(gl).toBeDefined();
  });

  it("flags POC-less projects, at-risk milestones, and old open contradictions", async () => {
    // Milestone due tomorrow, project has no recently-updated work items.
    const [milestone] = await db
      .insert(tables.milestones)
      .values({
        gitlabMilestoneId: Math.floor(Math.random() * 1_000_000_000),
        projectId,
        title: "Lint Test Milestone",
        state: "active",
        dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      })
      .returning();

    // Contradiction opened 10 days ago.
    const mkEvent = async (title: string) =>
      (
        await createEvent(db, {
          type: "status_change",
          title,
          confidence: 0.8,
          artifactId,
          projectIds: [projectId],
        })
      ).eventId;
    const [contradiction] = await db
      .insert(tables.contradictions)
      .values({
        projectId,
        eventAId: await mkEvent("Lint says shipped"),
        eventBId: await mkEvent("Lint says not shipped"),
        summary: "Lint test contradiction",
        createdAt: new Date(Date.now() - 10 * 86_400_000),
      })
      .returning();

    await lintAll(makeDeps());

    expect((await findingByKey(`orphan:project-poc:${projectId}`))?.status).toBe("open");
    expect((await findingByKey(`milestone_risk:${milestone!.id}`))?.status).toBe("open");
    expect((await findingByKey(`unresolved_contradiction:${contradiction!.id}`))?.status).toBe(
      "open",
    );
  });

  it("files narrative-drift findings from the model, keyed to the revision", async () => {
    const [narrative] = await db
      .insert(tables.narratives)
      .values({ projectId, kind: "status" })
      .returning();
    const { eventId } = await createEvent(db, {
      type: "status_change",
      title: "Feature X shipped",
      confidence: 0.9,
      artifactId,
      projectIds: [projectId],
    });
    const { revisionId } = await createNarrativeRevision(db, {
      narrativeId: narrative!.id,
      body: "Feature X has shipped to production.",
      citedEventIds: [eventId],
    });

    // A work item for the project so the drift check has tracker state.
    await db.insert(tables.workItems).values({
      source: "gitlab",
      kind: "merge_request",
      sourceId: String(Math.floor(Math.random() * 1_000_000_000)),
      reference: "!77",
      projectId,
      title: "Ship feature X",
      state: "opened",
      webUrl: "https://gitlab.com/exampleorg/lint/test/-/merge_requests/77",
    });

    const fakeLlm = {
      invoke: async () =>
        ({
          text: "",
          message: {
            role: "assistant",
            content: [
              {
                toolUse: {
                  name: "emit_findings",
                  input: {
                    findings: [
                      {
                        summary: "Narrative says feature X shipped but MR !77 is still open",
                        work_item_references: ["!77"],
                      },
                    ],
                  },
                },
              },
            ],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 200, outputTokens: 100 },
          costUsd: 0.005,
          modelId: "fake-mid",
        }) as unknown as LlmResponse,
      spentTodayUsd: async () => 0,
      config: {} as Llm["config"],
    } as unknown as Llm;

    const result = await lintAll(makeDeps(fakeLlm));
    expect(result.driftChecked).toBeGreaterThan(0);

    const [drift] = await db
      .select()
      .from(tables.lintFindings)
      .where(
        and(
          eq(tables.lintFindings.kind, "narrative_drift"),
          eq(tables.lintFindings.projectId, projectId),
          eq(tables.lintFindings.status, "open"),
        ),
      );
    expect(drift).toBeDefined();
    expect(drift!.dedupeKey.startsWith(`narrative_drift:${revisionId}:`)).toBe(true);
    expect(drift!.summary).toContain("!77");
  });
});

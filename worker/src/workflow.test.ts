import { randomUUID } from "node:crypto";
import { applyMigrations, createEvent, tables } from "@second-brain/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Client, type WorkerDeps } from "./lib/deps.ts";
import type { Llm, LlmRequest, LlmResponse } from "./lib/llm.ts";
import {
  draftWorkflow,
  executeApprovedActions,
  expireStaleDrafts,
  failStalePendingWorkflows,
} from "./workflow.ts";

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

describe.skipIf(!stackUp)("workflow agent", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  const run = randomUUID().slice(0, 8);
  let personId: string;
  let projectSlug: string;
  let eventId: string;

  function makeDeps(llm?: Llm): WorkerDeps {
    return {
      db,
      s3: createS3Client({
        S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000",
        S3_REGION: "us-east-1",
      } as NodeJS.ProcessEnv),
      bucket: process.env.S3_BUCKET_RAW ?? "second-brain-raw",
      enqueue: () => {},
      logger: pino({ level: "silent" }),
      llm,
    };
  }

  function scriptedLlm(
    script: ((
      requests: LlmRequest[],
    ) => { name: string; input: unknown } | { name: string; input: unknown }[])[],
  ): Llm {
    const requests: LlmRequest[] = [];
    return {
      invoke: async (_agent: string, request: LlmRequest) => {
        requests.push(request);
        const step = script[Math.min(requests.length - 1, script.length - 1)]!;
        const calls = [step(requests)].flat();
        return {
          text: "",
          message: {
            role: "assistant",
            content: calls.map((c, i) => ({
              toolUse: { toolUseId: `tu-${requests.length}-${i}`, name: c.name, input: c.input },
            })),
          },
          stopReason: "tool_use",
          usage: { inputTokens: 100, outputTokens: 200 },
          costUsd: 0.01,
          modelId: "fake",
        } as unknown as LlmResponse;
      },
      spentTodayUsd: async () => 0,
      config: {} as Llm["config"],
    } as unknown as Llm;
  }

  async function makeRequest(text: string): Promise<string> {
    const [row] = await db
      .insert(tables.workflowRequests)
      .values({ request: text, requestedById: personId })
      .returning({ id: tables.workflowRequests.id });
    return row!.id;
  }

  beforeAll(async () => {
    await applyMigrations(sql);
    const [person] = await db
      .insert(tables.people)
      .values({
        displayName: "Workflow Asker",
        email: `wf-${run}@test.example`,
        slackUserId: `U${run}`,
      })
      .returning();
    personId = person!.id;

    projectSlug = `wf-gadget-${run}`;
    const [project] = await db
      .insert(tables.projects)
      .values({ slug: projectSlug, name: `Workflow Gadget ${run}` })
      .returning();
    const [artifact] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "slack", sourceKey: `wf:${randomUUID()}`, objectKey: "raw/wf.json" })
      .returning();
    ({ eventId } = await createEvent(db, {
      type: "deadline_slipped",
      title: `Gadget ${run} milestone slipped one week`,
      confidence: 0.9,
      artifactId: artifact!.id,
      projectIds: [project!.id],
    }));
  });

  afterAll(async () => {
    await sql.end();
  });

  it("drafts subtasks and slack/jira actions with valid citations", async () => {
    const requestId = await makeRequest(
      `Tell the team the Gadget ${run} milestone slipped and file a Jira follow-up`,
    );
    const llm = scriptedLlm([
      () => ({ name: "project_status", input: { slug: projectSlug } }),
      () => ({
        name: "emit_plan",
        input: {
          summary_markdown: `Milestone slipped [event:${eventId}]; drafting a Slack note and Jira task.`,
          cited_event_ids: [eventId],
          subtasks: [
            {
              title: "Notify team",
              description: "Slack update",
              route: "person",
              suggested_person_email: `wf-${run}@test.example`,
            },
            {
              title: "File follow-up",
              description: "Jira task",
              route: "person",
            },
          ],
          actions: [
            {
              kind: "slack_message",
              title: "Milestone slip notice",
              body: `The Gadget ${run} milestone slipped [event:${eventId}].`,
              destination: { slack_channel: "C-testing" },
              cited_event_ids: [eventId],
              subtask_index: 0,
            },
            {
              kind: "jira_issue",
              title: `Recover Gadget ${run} milestone`,
              body: `Follow up on the slipped milestone [event:${eventId}].`,
              destination: { jira_project_key: "EX" },
              cited_event_ids: [eventId],
              subtask_index: 1,
            },
          ],
        },
      }),
    ]);

    const result = await draftWorkflow(makeDeps(llm), requestId);
    expect(result.status).toBe("drafted");

    const [req] = await db
      .select()
      .from(tables.workflowRequests)
      .where(eq(tables.workflowRequests.id, requestId));
    expect(req!.status).toBe("drafted");
    expect(req!.summary).toContain(eventId);

    const subtasks = await db
      .select()
      .from(tables.workflowSubtasks)
      .where(eq(tables.workflowSubtasks.requestId, requestId));
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0]!.suggestedPersonId).toBe(personId);

    const actions = await db
      .select()
      .from(tables.workflowActions)
      .where(eq(tables.workflowActions.requestId, requestId));
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.status === "draft")).toBe(true);
  });

  it("executes approved actions via dry-run executor and records outcomes", async () => {
    const requestId = await makeRequest(`Document-only plan ${run}`);
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.insert(tables.workflowActions).values({
      requestId,
      kind: "document",
      title: "Status brief",
      body: "# Brief\n\nAll good.",
      destination: {},
      status: "approved",
      approvedById: personId,
      approvedAt: new Date(),
      expiresAt,
    });
    await db
      .update(tables.workflowRequests)
      .set({ status: "drafted", draftedAt: new Date() })
      .where(eq(tables.workflowRequests.id, requestId));

    const actions = await db
      .select()
      .from(tables.workflowActions)
      .where(eq(tables.workflowActions.requestId, requestId));
    const outcome = await executeApprovedActions(makeDeps(), [actions[0]!.id], { dryRun: true });
    expect(outcome.executed).toBe(1);
    expect(outcome.failed).toBe(0);

    const [done] = await db
      .select()
      .from(tables.workflowActions)
      .where(eq(tables.workflowActions.id, actions[0]!.id));
    expect(done!.status).toBe("executed");

    const [req] = await db
      .select()
      .from(tables.workflowRequests)
      .where(eq(tables.workflowRequests.id, requestId));
    expect(req!.status).toBe("completed");
  });

  it("expires unapproved drafts past expires_at", async () => {
    const requestId = await makeRequest(`Expiring ${run}`);
    const [action] = await db
      .insert(tables.workflowActions)
      .values({
        requestId,
        kind: "email",
        title: "Old draft",
        body: "stale",
        destination: { emailTo: ["a@test"] },
        status: "draft",
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();

    const n = await expireStaleDrafts(makeDeps());
    expect(n).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select()
      .from(tables.workflowActions)
      .where(eq(tables.workflowActions.id, action!.id));
    expect(row!.status).toBe("expired");
  });

  it("sweeps stale pending requests", async () => {
    const requestId = await makeRequest(`Stuck ${run}`);
    await db
      .update(tables.workflowRequests)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(tables.workflowRequests.id, requestId));

    const swept = await failStalePendingWorkflows(makeDeps(), 15 * 60_000);
    expect(swept).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select()
      .from(tables.workflowRequests)
      .where(eq(tables.workflowRequests.id, requestId));
    expect(row!.status).toBe("failed");
  });
});

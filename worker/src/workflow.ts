/**
 * Workflow agent (tasks 6.1–6.4): natural-language request → draft sub-tasks
 * and outbound actions with citations; approval gates execution via the
 * scoped executor (6.5). Nothing is sent/filed until a human approves.
 *
 * Frontier tier, budget-capped. Validation failures get one retryFeedback;
 * a second failure marks the request failed — never a partial plan write.
 */
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { tables } from "@second-brain/schema";
import { z } from "zod";
import type { ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";
import type { WorkerDeps } from "./lib/deps.ts";
import { retryFeedback } from "./lib/llm.ts";
import { emitMetric } from "./lib/metrics.ts";
import { projectStatus, searchBrain } from "./query.ts";
import {
  actionNameForKind,
  clientsFromEnv,
  executeNamedAction,
  type Destination,
  type ExecutorClients,
} from "./executor.ts";

const MAX_TURNS = Number(process.env.WORKFLOW_MAX_TURNS ?? 6);
const DRAFT_TTL_MS = Number(process.env.WORKFLOW_DRAFT_TTL_MS ?? 7 * 24 * 60 * 60_000);

const planSchema = z.object({
  summary_markdown: z.string().min(20),
  cited_event_ids: z.array(z.string().uuid()),
  subtasks: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(4000).default(""),
        route: z.enum(["person", "agent_workflow", "none"]).default("none"),
        suggested_person_email: z.string().email().optional(),
      }),
    )
    .max(20)
    .default([]),
  actions: z
    .array(
      z.object({
        kind: z.enum(["jira_issue", "slack_message", "email", "document"]),
        title: z.string().min(3).max(255),
        body: z.string().min(1).max(40_000),
        destination: z
          .object({
            jira_project_key: z.string().optional(),
            assignee_email: z.string().email().optional(),
            slack_channel: z.string().optional(),
            slack_user_id: z.string().optional(),
            email_to: z.array(z.string().email()).optional(),
            email_subject: z.string().optional(),
          })
          .default({}),
        cited_event_ids: z.array(z.string().uuid()).default([]),
        subtask_index: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(30),
});

const TOOLS: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "search_brain",
        description:
          "Full-text search over the org knowledge base: typed events, current project narratives, and projects.",
        inputSchema: {
          json: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "project_status",
        description:
          "Structured drill-down for one project by slug: status, POC, narrative, blockers, deadlines.",
        inputSchema: {
          json: {
            type: "object",
            properties: { slug: { type: "string" } },
            required: ["slug"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "lookup_person",
        description: "Find a person by email or display-name fragment for routing suggestions.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              email: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
    },
    {
      toolSpec: {
        name: "emit_plan",
        description:
          "Emit the final draft plan: summary, optional sub-tasks, and at least one outbound action draft. Nothing is sent until a human approves.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              summary_markdown: {
                type: "string",
                description: "Plan summary with [event:<id>] citations where claims are made.",
              },
              cited_event_ids: {
                type: "array",
                items: { type: "string" },
              },
              subtasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    description: { type: "string" },
                    route: { type: "string", enum: ["person", "agent_workflow", "none"] },
                    suggested_person_email: { type: "string" },
                  },
                  required: ["title"],
                },
              },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["jira_issue", "slack_message", "email", "document"],
                    },
                    title: { type: "string" },
                    body: { type: "string" },
                    destination: { type: "object" },
                    cited_event_ids: { type: "array", items: { type: "string" } },
                    subtask_index: { type: "number" },
                  },
                  required: ["kind", "title", "body"],
                },
              },
            },
            required: ["summary_markdown", "cited_event_ids", "actions"],
          },
        },
      },
    },
  ],
  toolChoice: { any: {} },
};

const SYSTEM = `You are the Workflow agent for an engineering org knowledge base. You turn natural-language requests into DRAFT outbound actions — never send, post, or file anything yourself.

You have tools: search_brain, project_status, lookup_person, and emit_plan (your final output).

Rules:
- Gather evidence first when the request depends on project state or prior decisions. Cite events as [event:<id>] using ids from tool results only.
- Decompose large multi-owner requests into subtasks with suggested routing (person | agent_workflow | none).
- Emit one or more action drafts. Allowed kinds:
  - jira_issue: destination.jira_project_key required; body is the issue description.
  - slack_message: destination.slack_channel (channel id/name) or slack_user_id for a DM; body is the full message.
  - email: destination.email_to (array) and optional email_subject; body is the email body.
  - document: internal draft document; body is the full markdown content.
- Every factual claim in summary_markdown or action bodies that draws on the brain must cite events. List used ids in cited_event_ids (plan-level and per-action).
- Prefill destination from evidence when known; leave fields empty rather than inventing channel ids or emails.
- Be concrete: the human must see a full content preview before approving.`;

async function lookupPerson(
  deps: WorkerDeps,
  input: { email?: string; name?: string },
): Promise<unknown> {
  const email = input.email?.trim().toLowerCase();
  const name = input.name?.trim();
  if (!email && !name) return { error: "email or name is required" };

  if (email) {
    const [row] = await deps.db
      .select({
        id: tables.people.id,
        displayName: tables.people.displayName,
        email: tables.people.email,
        slackUserId: tables.people.slackUserId,
      })
      .from(tables.people)
      .where(sql`lower(${tables.people.email}) = ${email}`)
      .limit(1);
    return row ?? { found: false };
  }

  const rows = await deps.db
    .select({
      id: tables.people.id,
      displayName: tables.people.displayName,
      email: tables.people.email,
      slackUserId: tables.people.slackUserId,
    })
    .from(tables.people)
    .where(sql`${tables.people.displayName} ilike ${`%${name}%`}`)
    .limit(10);
  return { matches: rows };
}

function toDestination(raw: z.infer<typeof planSchema>["actions"][number]["destination"]): Destination {
  return {
    jiraProjectKey: raw.jira_project_key,
    assigneeEmail: raw.assignee_email,
    slackChannel: raw.slack_channel,
    slackUserId: raw.slack_user_id,
    emailTo: raw.email_to,
    emailSubject: raw.email_subject,
  };
}

export async function draftWorkflow(
  deps: WorkerDeps,
  requestId: string,
): Promise<{ status: "drafted" | "failed"; turns: number }> {
  if (!deps.llm) throw new Error("llm not configured; cannot draft workflows");

  const [row] = await deps.db
    .select()
    .from(tables.workflowRequests)
    .where(eq(tables.workflowRequests.id, requestId));
  if (!row) throw new Error(`workflow: no workflow_requests row ${requestId}`);
  if (row.status === "drafted" || row.status === "completed") {
    return { status: "drafted", turns: 0 };
  }

  const seenEventIds = new Set<string>();
  let validationRetries = 0;
  const messages: Parameters<NonNullable<WorkerDeps["llm"]>["invoke"]>[1]["messages"] = [
    { role: "user", content: [{ text: `Request: ${row.request.slice(0, 4000)}` }] },
  ];

  const fail = async (error: string, turns: number) => {
    await deps.db
      .update(tables.workflowRequests)
      .set({ status: "failed", error })
      .where(eq(tables.workflowRequests.id, requestId));
    emitMetric("workflow_failed", 1, { stage: "workflow" });
    deps.logger.error({ requestId, error }, "workflow draft failed");
    return { status: "failed" as const, turns };
  };

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const lastTurn = turn === MAX_TURNS;
    const response = await deps.llm.invoke("workflow", {
      system: SYSTEM,
      messages,
      toolConfig: (lastTurn
        ? { ...TOOLS, toolChoice: { tool: { name: "emit_plan" } } }
        : TOOLS) as never,
      maxTokens: 6000,
      temperature: 0,
      purpose: `workflow:${requestId}`,
    });

    const toolUses =
      response.message?.content?.flatMap((b) => (b.toolUse ? [b.toolUse] : [])) ?? [];
    if (toolUses.length === 0) {
      return fail("model produced no tool call", turn);
    }
    messages.push({
      role: "assistant",
      content: response.message?.content ?? [{ text: response.text }],
    });

    let emitError = "";
    const emit = toolUses.find((t) => t.name === "emit_plan");
    if (emit) {
      const parsed = planSchema.safeParse(emit.input);
      const idsValid =
        parsed.success &&
        parsed.data.cited_event_ids.every((id) => seenEventIds.has(id)) &&
        parsed.data.actions.every((a) => a.cited_event_ids.every((id) => seenEventIds.has(id)));
      if (parsed.success && idsValid) {
        await persistPlan(deps, requestId, parsed.data, `workflow:${response.modelId}`);
        emitMetric("workflows_drafted", 1, { stage: "workflow" });
        deps.logger.info(
          {
            requestId,
            turns: turn,
            actions: parsed.data.actions.length,
            subtasks: parsed.data.subtasks.length,
          },
          "workflow drafted",
        );
        return { status: "drafted", turns: turn };
      }

      emitError = parsed.success
        ? "cited_event_ids contains ids that did not appear in any tool result"
        : parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")
            .slice(0, 400);
      if (++validationRetries > 1) {
        return fail(`plan failed validation twice: ${emitError}`, turn);
      }
      deps.logger.warn({ requestId, turn, error: emitError }, "workflow plan failed validation");
    }

    const resultBlocks: NonNullable<
      Parameters<NonNullable<WorkerDeps["llm"]>["invoke"]>[1]["messages"][number]["content"]
    > = [];
    for (const toolUse of toolUses) {
      if (toolUse.name === "emit_plan") {
        const feedback = retryFeedback(
          toolUse.toolUseId,
          `Your emit_plan call failed validation: ${emitError}. Call emit_plan again; cite only event ids returned by your tool calls.`,
        );
        resultBlocks.push(...(feedback.content ?? []));
        continue;
      }
      let result: unknown;
      if (toolUse.name === "search_brain") {
        const q = String((toolUse.input as { query?: unknown })?.query ?? "").slice(0, 300);
        result = q ? await searchBrain(deps, q, seenEventIds) : { error: "query is required" };
      } else if (toolUse.name === "project_status") {
        const slug = String((toolUse.input as { slug?: unknown })?.slug ?? "");
        result = slug
          ? await projectStatus(deps, slug, seenEventIds)
          : { error: "slug is required" };
      } else if (toolUse.name === "lookup_person") {
        const inp = toolUse.input as { email?: string; name?: string };
        result = await lookupPerson(deps, {
          email: inp.email ? String(inp.email) : undefined,
          name: inp.name ? String(inp.name) : undefined,
        });
      } else {
        result = { error: `unknown tool ${toolUse.name}` };
      }
      resultBlocks.push({
        toolResult: {
          toolUseId: toolUse.toolUseId,
          content: [{ text: JSON.stringify(result).slice(0, 30_000) }],
        },
      });
    }
    messages.push({ role: "user", content: resultBlocks });
  }

  return fail(`no plan after ${MAX_TURNS} turns`, MAX_TURNS);
}

async function persistPlan(
  deps: WorkerDeps,
  requestId: string,
  plan: z.infer<typeof planSchema>,
  draftedBy: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + DRAFT_TTL_MS);

  // Resolve suggested people by email (best-effort).
  const emails = [
    ...plan.subtasks.map((s) => s.suggested_person_email?.toLowerCase()).filter(Boolean),
    ...plan.actions.map((a) => a.destination.assignee_email?.toLowerCase()).filter(Boolean),
  ] as string[];
  const peopleByEmail = new Map<string, string>();
  if (emails.length > 0) {
    const uniq = [...new Set(emails)];
    const rows = await deps.db
      .select({ id: tables.people.id, email: tables.people.email })
      .from(tables.people);
    for (const r of rows) {
      if (r.email && uniq.includes(r.email.toLowerCase())) {
        peopleByEmail.set(r.email.toLowerCase(), r.id);
      }
    }
  }

  await deps.db.transaction(async (tx) => {
    // Replace any prior partial drafts (should not exist for pending rows).
    await tx.delete(tables.workflowActions).where(eq(tables.workflowActions.requestId, requestId));
    await tx.delete(tables.workflowSubtasks).where(eq(tables.workflowSubtasks.requestId, requestId));

    const subtaskIds: string[] = [];
    for (let i = 0; i < plan.subtasks.length; i++) {
      const s = plan.subtasks[i]!;
      const [row] = await tx
        .insert(tables.workflowSubtasks)
        .values({
          requestId,
          sortOrder: i,
          title: s.title,
          description: s.description,
          route: s.route,
          suggestedPersonId: s.suggested_person_email
            ? peopleByEmail.get(s.suggested_person_email.toLowerCase())
            : undefined,
          status: "proposed",
        })
        .returning({ id: tables.workflowSubtasks.id });
      subtaskIds.push(row!.id);
    }

    for (const a of plan.actions) {
      const subtaskId =
        a.subtask_index !== undefined && a.subtask_index < subtaskIds.length
          ? subtaskIds[a.subtask_index]
          : undefined;
      await tx.insert(tables.workflowActions).values({
        requestId,
        subtaskId,
        kind: a.kind,
        title: a.title,
        body: a.body,
        destination: toDestination(a.destination),
        citedEventIds: a.cited_event_ids,
        status: "draft",
        expiresAt,
      });
    }

    await tx
      .update(tables.workflowRequests)
      .set({
        status: "drafted",
        summary: plan.summary_markdown,
        citedEventIds: plan.cited_event_ids,
        draftedBy,
        draftedAt: new Date(),
        error: null,
      })
      .where(eq(tables.workflowRequests.id, requestId));
  });
}

/**
 * Execute approved actions (task 6.4 routing + 6.5 executor). Idempotent:
 * already-executed rows are skipped. Updates parent request to completed when
 * no draft/approved/executing actions remain.
 */
export async function executeApprovedActions(
  deps: WorkerDeps,
  actionIds: string[],
  clients: ExecutorClients = clientsFromEnv(),
): Promise<{ executed: number; failed: number }> {
  if (actionIds.length === 0) return { executed: 0, failed: 0 };

  const rows = await deps.db
    .select()
    .from(tables.workflowActions)
    .where(inArray(tables.workflowActions.id, actionIds));

  let executed = 0;
  let failed = 0;
  const requestIds = new Set<string>();

  for (const row of rows) {
    requestIds.add(row.requestId);
    if (row.status === "executed") {
      executed++;
      continue;
    }
    if (row.status !== "approved" && row.status !== "executing") continue;

    await deps.db
      .update(tables.workflowActions)
      .set({ status: "executing" })
      .where(eq(tables.workflowActions.id, row.id));

    const dest = (row.destination ?? {}) as Destination;
    const outcome = await executeNamedAction(deps, clients, {
      actionName: actionNameForKind(row.kind),
      actionId: row.id,
      title: row.title,
      body: row.body,
      destination: dest,
    });

    if (outcome.ok) {
      await deps.db
        .update(tables.workflowActions)
        .set({
          status: "executed",
          executedAt: new Date(),
          executionResult: { ...outcome.result, detail: outcome.detail },
        })
        .where(eq(tables.workflowActions.id, row.id));
      if (row.subtaskId) {
        await deps.db
          .update(tables.workflowSubtasks)
          .set({ status: "done" })
          .where(eq(tables.workflowSubtasks.id, row.subtaskId));
      }
      executed++;
    } else {
      await deps.db
        .update(tables.workflowActions)
        .set({
          status: "failed",
          executedAt: new Date(),
          executionResult: {
            ...outcome.result,
            detail: outcome.detail,
            allowed: outcome.allowed,
          },
        })
        .where(eq(tables.workflowActions.id, row.id));
      failed++;
    }
  }

  for (const requestId of requestIds) {
    await refreshRequestStatus(deps, requestId);
  }

  return { executed, failed };
}

async function refreshRequestStatus(deps: WorkerDeps, requestId: string): Promise<void> {
  const open = await deps.db
    .select({ id: tables.workflowActions.id, status: tables.workflowActions.status })
    .from(tables.workflowActions)
    .where(eq(tables.workflowActions.requestId, requestId));

  const stillOpen = open.some((a) =>
    ["draft", "approved", "executing"].includes(a.status),
  );
  if (stillOpen) return;

  const anyExecuted = open.some((a) => a.status === "executed");
  if (anyExecuted) {
    await deps.db
      .update(tables.workflowRequests)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(tables.workflowRequests.id, requestId));
  }
}

/** Expire unapproved drafts past expires_at (agent-workflows spec). */
export async function expireStaleDrafts(deps: WorkerDeps): Promise<number> {
  const now = new Date();
  const expired = await deps.db
    .update(tables.workflowActions)
    .set({ status: "expired" })
    .where(
      and(
        eq(tables.workflowActions.status, "draft"),
        lt(tables.workflowActions.expiresAt, now),
      ),
    )
    .returning({ id: tables.workflowActions.id, requestId: tables.workflowActions.requestId });

  for (const row of expired) {
    await refreshRequestStatus(deps, row.requestId);
  }
  if (expired.length > 0) {
    emitMetric("workflow_drafts_expired", expired.length, { stage: "workflow" });
    deps.logger.info({ count: expired.length }, "expired unapproved workflow drafts");
  }
  return expired.length;
}

export async function failStalePendingWorkflows(
  deps: WorkerDeps,
  maxAgeMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const swept = await deps.db
    .update(tables.workflowRequests)
    .set({
      status: "failed",
      error: "the drafting job did not complete — submit again",
    })
    .where(
      and(
        eq(tables.workflowRequests.status, "pending"),
        lt(tables.workflowRequests.createdAt, cutoff),
      ),
    )
    .returning({ id: tables.workflowRequests.id });
  if (swept.length > 0) {
    emitMetric("workflows_swept_stale", swept.length, { stage: "workflow" });
    deps.logger.warn({ count: swept.length }, "marked stale pending workflows failed");
  }
  return swept.length;
}

/** Approve proposed subtasks when their linked actions are approved. */
export async function markSubtasksApproved(
  deps: WorkerDeps,
  subtaskIds: string[],
): Promise<void> {
  if (subtaskIds.length === 0) return;
  await deps.db
    .update(tables.workflowSubtasks)
    .set({ status: "approved" })
    .where(
      and(
        inArray(tables.workflowSubtasks.id, subtaskIds),
        eq(tables.workflowSubtasks.status, "proposed"),
      ),
    );
}

export async function listActionsForRequest(deps: WorkerDeps, requestId: string) {
  return deps.db
    .select()
    .from(tables.workflowActions)
    .where(eq(tables.workflowActions.requestId, requestId))
    .orderBy(asc(tables.workflowActions.createdAt));
}

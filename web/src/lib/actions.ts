"use server";

/**
 * Mutating server actions (tasks 5.4, 5.8). All enforce the D4 trust model
 * server-side via the shared ops: POC / backup POC / L1 only. Errors surface
 * as a ?error= banner on the page the user came from.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import {
  assignProjectOwnership,
  canReject,
  InvalidOperationError,
  NotAuthorizedError,
  NotFoundError,
  rejectEvent,
  rejectNarrativeRevision,
  tables,
} from "@second-brain/schema";
import { getUser } from "./auth";
import { db } from "./db";
import { createJiraIssue, jiraProjectForSlug, jiraSyncConfig } from "./jira";
import { personByEmail } from "./queries";
import { enqueueExecuteWorkflow, enqueueQuery, enqueueReport, enqueueResynthesis, enqueueWorkflow } from "./queue";
import { sendOwnershipNotifications } from "./slack";
import { presentSlackText } from "./slack-names";
import { headers } from "next/headers";

function backTo(formData: FormData): string {
  const raw = formData.get("returnTo");
  // Same-origin paths only; anything else falls back to the feed.
  return typeof raw === "string" && raw.startsWith("/") ? raw : "/activity";
}

function redirectWithError(path: string, message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}error=${encodeURIComponent(message)}`);
}

/** EMF line for CloudWatch (task 7.2 rejection-rate dashboard). */
function emitRejectionMetric(): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "second-brain/funnel",
            Dimensions: [["stage"]],
            Metrics: [{ Name: "rejection", Unit: "Count" }],
          },
        ],
      },
      stage: "reject",
      rejection: 1,
    }),
  );
}

async function requirePerson() {
  const user = await getUser();
  const person = await personByEmail(user.email);
  return { user, person };
}

export async function rejectEventAction(formData: FormData): Promise<void> {
  const eventId = String(formData.get("eventId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const returnTo = backTo(formData);
  if (!eventId) redirectWithError(returnTo, "missing event id");
  if (!reason) redirectWithError(returnTo, "a reason is required to reject");

  const { person } = await requirePerson();
  if (!person) redirectWithError(returnTo, "your account is not linked to a person record");

  try {
    await rejectEvent(db(), {
      eventId,
      personId: person.id,
      reason,
      enqueue: enqueueResynthesis,
    });
    emitRejectionMetric();
  } catch (err) {
    if (err instanceof NotAuthorizedError) {
      redirectWithError(returnTo, "only the project POC, backup POC, or L1 can reject");
    }
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(returnTo);
}

export async function rejectRevisionAction(formData: FormData): Promise<void> {
  const revisionId = String(formData.get("revisionId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const returnTo = backTo(formData);
  if (!revisionId) redirectWithError(returnTo, "missing revision id");
  if (!reason) redirectWithError(returnTo, "a reason is required to reject");

  const { person } = await requirePerson();
  if (!person) redirectWithError(returnTo, "your account is not linked to a person record");

  try {
    await rejectNarrativeRevision(db(), {
      revisionId,
      personId: person.id,
      reason,
      enqueue: enqueueResynthesis,
    });
    emitRejectionMetric();
  } catch (err) {
    if (err instanceof NotAuthorizedError) {
      redirectWithError(returnTo, "only the project POC, backup POC, or L1 can reject");
    }
    throw err;
  }
  revalidatePath("/", "layout");
  redirect(returnTo);
}

/**
 * One-click Jira issue creation from an untracked-work record (spec: explicit
 * human action — this is the D4 carve-out where a click *is* the approval).
 */
export async function createIssueAction(formData: FormData): Promise<void> {
  const untrackedId = String(formData.get("untrackedId") ?? "");
  const returnTo = backTo(formData);
  if (!untrackedId) redirectWithError(returnTo, "missing untracked-work id");

  const { person } = await requirePerson();
  if (!person) redirectWithError(returnTo, "your account is not linked to a person record");

  const [row] = await db()
    .select({
      id: tables.untrackedWork.id,
      title: tables.untrackedWork.title,
      status: tables.untrackedWork.status,
      projectId: tables.untrackedWork.projectId,
      projectSlug: tables.projects.slug,
      projectName: tables.projects.name,
      eventTitle: tables.events.title,
      eventBody: tables.events.body,
      eventPermalink: tables.events.permalink,
    })
    .from(tables.untrackedWork)
    .innerJoin(tables.projects, eq(tables.projects.id, tables.untrackedWork.projectId))
    .innerJoin(tables.events, eq(tables.events.id, tables.untrackedWork.eventId))
    .where(eq(tables.untrackedWork.id, untrackedId));
  if (!row) redirectWithError(returnTo, "untracked-work record not found");
  if (row.status !== "open") redirectWithError(returnTo, "already resolved");

  if (!(await canReject(db(), person.id, [row.projectId]))) {
    redirectWithError(returnTo, "only the project POC, backup POC, or L1 can create issues");
  }

  const description = [
    row.eventBody ?? row.eventTitle,
    "",
    `Created by second-brain from untracked work detected in ${row.projectName}.`,
    row.eventPermalink ? `Source: ${row.eventPermalink}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const summary = await presentSlackText(row.title);
  const namedDescription = await presentSlackText(description);

  const projectKey = jiraProjectForSlug(jiraSyncConfig(), row.projectSlug);
  let issue: { key: string; webUrl: string };
  try {
    issue = await createJiraIssue({
      projectKey,
      summary,
      description: namedDescription,
      labels: ["brain-untracked"],
    });
  } catch (err) {
    redirectWithError(returnTo, `Jira create failed: ${(err as Error).message.slice(0, 120)}`);
  }

  // Mirror the new issue immediately so links resolve before the next poll.
  const [workItem] = await db()
    .insert(tables.workItems)
    .values({
      source: "jira",
      kind: "issue",
      sourceId: issue.key,
      reference: issue.key,
      sourceProject: projectKey,
      projectId: row.projectId,
      title: summary,
      state: "new",
      webUrl: issue.webUrl,
      labels: ["brain-untracked"],
      sourceUpdatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: tables.workItems.id });

  await db()
    .update(tables.untrackedWork)
    .set({
      status: "issue_created",
      workItemId: workItem?.id,
      issueWebUrl: issue.webUrl,
      resolvedAt: new Date(),
    })
    .where(eq(tables.untrackedWork.id, untrackedId));

  revalidatePath("/", "layout");
  const sep = returnTo.includes("?") ? "&" : "?";
  redirect(
    `${returnTo}${sep}created=${encodeURIComponent(issue.key)}&board=${encodeURIComponent(projectKey)}&url=${encodeURIComponent(issue.webUrl)}`,
  );
}

/**
 * On-demand report generation (task 4.8, web-app spec: Report generation).
 * L1-gated — reports address leadership and burn frontier-tier tokens.
 */
export async function requestReportAction(formData: FormData): Promise<void> {
  const scope = formData.get("scope") === "team" ? ("team" as const) : ("portfolio" as const);
  const teamId = String(formData.get("teamId") ?? "");
  const returnTo = backTo(formData);
  if (scope === "team" && !teamId) redirectWithError(returnTo, "pick a team for a team report");

  const { user, person } = await requirePerson();
  if (user.role !== "L1") redirectWithError(returnTo, "only L1 can request reports");
  if (!person) redirectWithError(returnTo, "your account is not linked to a person record");

  await enqueueReport({
    scope,
    teamId: scope === "team" ? teamId : undefined,
    requestedById: person.id,
  });
  revalidatePath("/reports");
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}queued=1`);
}

/**
 * Explicit publish action (D4: distributing a report is never automatic).
 * Flips the draft to published and stamps who/when; audience-scoped access
 * enforcement layers on with 5.11.
 */
export async function publishReportAction(formData: FormData): Promise<void> {
  const reportId = String(formData.get("reportId") ?? "");
  const returnTo = backTo(formData);
  if (!reportId) redirectWithError(returnTo, "missing report id");

  const { user, person } = await requirePerson();
  if (user.role !== "L1") redirectWithError(returnTo, "only L1 can publish reports");
  if (!person) redirectWithError(returnTo, "your account is not linked to a person record");

  const [row] = await db()
    .select({ status: tables.reports.status })
    .from(tables.reports)
    .where(eq(tables.reports.id, reportId));
  if (!row) redirectWithError(returnTo, "report not found");
  if (row.status === "published") redirectWithError(returnTo, "already published");

  await db()
    .update(tables.reports)
    .set({ status: "published", publishedById: person.id, publishedAt: new Date() })
    .where(eq(tables.reports.id, reportId));

  revalidatePath("/reports");
  redirect(returnTo);
}

/**
 * Follow/unfollow a project (task 5.9): the self-service opt-in that scopes
 * the daily digest beyond owned projects. Any linked person can follow.
 */
export async function toggleFollowAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const returnTo = backTo(formData);
  if (!projectId) redirectWithError(returnTo, "missing project id");

  const { person } = await requirePerson();
  if (!person) redirectWithError(returnTo, "your account is not linked to a person record");

  const deleted = await db()
    .delete(tables.projectFollows)
    .where(
      and(
        eq(tables.projectFollows.personId, person.id),
        eq(tables.projectFollows.projectId, projectId),
      ),
    )
    .returning({ projectId: tables.projectFollows.projectId });
  if (deleted.length === 0) {
    await db()
      .insert(tables.projectFollows)
      .values({ personId: person.id, projectId })
      .onConflictDoNothing();
  }

  revalidatePath(returnTo);
  redirect(returnTo);
}

/**
 * Assign or clear a project's primary / backup POC (project-ownership).
 * L1-only; authorization is enforced in the shared ops layer.
 */
export async function assignOwnershipAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const returnTo = backTo(formData);
  if (!projectId) redirectWithError(returnTo, "missing project id");

  const { person } = await requirePerson();
  if (!person) redirectWithError(returnTo, "your account is not linked to a person record");

  const rawPoc = formData.get("pocId");
  const rawBackup = formData.get("backupPocId");
  const pocId =
    typeof rawPoc === "string" ? (rawPoc === "" ? null : rawPoc) : undefined;
  const backupPocId =
    typeof rawBackup === "string" ? (rawBackup === "" ? null : rawBackup) : undefined;

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const baseUrl =
    process.env.APP_BASE_URL ?? (host ? `${proto}://${host}` : "http://localhost:3000");

  try {
    await assignProjectOwnership(db(), {
      projectId,
      actorPersonId: person.id,
      pocId,
      backupPocId,
      notify: (changes) => sendOwnershipNotifications(changes, baseUrl),
    });
  } catch (err) {
    if (err instanceof NotAuthorizedError) {
      redirectWithError(returnTo, "only L1 can assign project ownership");
    }
    if (err instanceof InvalidOperationError || err instanceof NotFoundError) {
      redirectWithError(returnTo, err.message);
    }
    throw err;
  }

  revalidatePath(returnTo);
  redirect(returnTo);
}

/** Ask the brain (task 5.7): create the pending query row and queue the agent. */
export async function askBrainAction(formData: FormData): Promise<void> {
  const question = String(formData.get("question") ?? "").trim();
  if (!question) redirectWithError("/ask", "a question is required");
  if (question.length > 2000) redirectWithError("/ask", "question is too long (2000 chars max)");

  const { person } = await requirePerson();
  if (!person) redirectWithError("/ask", "your account is not linked to a person record");

  const [row] = await db()
    .insert(tables.brainQueries)
    .values({ question, askedById: person.id })
    .returning({ id: tables.brainQueries.id });
  await enqueueQuery(row!.id);

  revalidatePath("/ask");
  redirect(`/ask/${row!.id}`);
}

/**
 * Save an answered query as an analysis (web-app spec: users MAY save answers
 * as analyses) — an explicit human action that makes the answer a first-class
 * searchable document.
 */
export async function saveAnalysisAction(formData: FormData): Promise<void> {
  const queryId = String(formData.get("queryId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const returnTo = backTo(formData);
  if (!queryId) redirectWithError(returnTo, "missing query id");
  if (!title) redirectWithError(returnTo, "a title is required to save an analysis");

  const { person } = await requirePerson();
  if (!person) redirectWithError(returnTo, "your account is not linked to a person record");

  const [query] = await db()
    .select({
      status: tables.brainQueries.status,
      answer: tables.brainQueries.answer,
      citedEventIds: tables.brainQueries.citedEventIds,
    })
    .from(tables.brainQueries)
    .where(eq(tables.brainQueries.id, queryId));
  if (!query) redirectWithError(returnTo, "query not found");
  if (query.status !== "answered" || !query.answer) {
    redirectWithError(returnTo, "only answered queries can be saved");
  }

  const [existing] = await db()
    .select({ id: tables.analyses.id })
    .from(tables.analyses)
    .where(eq(tables.analyses.queryId, queryId));
  if (existing) redirect(`/analyses/${existing.id}`);

  const [analysis] = await db()
    .insert(tables.analyses)
    .values({
      queryId,
      title: title.slice(0, 200),
      body: query.answer,
      citedEventIds: query.citedEventIds,
      savedById: person.id,
    })
    .returning({ id: tables.analyses.id });

  revalidatePath("/ask");
  redirect(`/analyses/${analysis!.id}`);
}

/** Start a workflow request (task 6.1): queue the Workflow agent to draft actions. */
export async function startWorkflowAction(formData: FormData): Promise<void> {
  const request = String(formData.get("request") ?? "").trim();
  if (!request) redirectWithError("/workflows", "a request is required");
  if (request.length > 4000) redirectWithError("/workflows", "request is too long (4000 chars max)");

  const { person } = await requirePerson();
  if (!person) redirectWithError("/workflows", "your account is not linked to a person record");

  const [row] = await db()
    .insert(tables.workflowRequests)
    .values({ request, requestedById: person.id })
    .returning({ id: tables.workflowRequests.id });
  await enqueueWorkflow(row!.id);

  revalidatePath("/workflows");
  redirect(`/workflows/${row!.id}`);
}

/**
 * Approve one or more draft actions (task 6.2) and enqueue execution (6.4/6.5).
 * Form field `actionIds` may be repeated for a scoped batch.
 */
export async function approveWorkflowActionsAction(formData: FormData): Promise<void> {
  const returnTo = backTo(formData);
  const actionIds = formData
    .getAll("actionIds")
    .map((v) => String(v))
    .filter(Boolean);
  if (actionIds.length === 0) redirectWithError(returnTo, "select at least one draft to approve");

  const { person } = await requirePerson();
  if (!person) redirectWithError(returnTo, "your account is not linked to a person record");

  const rows = await db()
    .select({
      id: tables.workflowActions.id,
      status: tables.workflowActions.status,
      expiresAt: tables.workflowActions.expiresAt,
      subtaskId: tables.workflowActions.subtaskId,
      requestId: tables.workflowActions.requestId,
    })
    .from(tables.workflowActions)
    .where(inArray(tables.workflowActions.id, actionIds));

  if (rows.length === 0) redirectWithError(returnTo, "no matching drafts found");

  const now = new Date();
  const approvable = rows.filter((r) => r.status === "draft" && r.expiresAt > now);
  if (approvable.length === 0) {
    redirectWithError(returnTo, "those drafts are no longer approvable (expired or already handled)");
  }

  const ids = approvable.map((r) => r.id);
  await db()
    .update(tables.workflowActions)
    .set({
      status: "approved",
      approvedById: person.id,
      approvedAt: now,
    })
    .where(inArray(tables.workflowActions.id, ids));

  const subtaskIds = [
    ...new Set(approvable.map((r) => r.subtaskId).filter((id): id is string => Boolean(id))),
  ];
  if (subtaskIds.length > 0) {
    await db()
      .update(tables.workflowSubtasks)
      .set({ status: "approved" })
      .where(
        and(
          inArray(tables.workflowSubtasks.id, subtaskIds),
          eq(tables.workflowSubtasks.status, "proposed"),
        ),
      );
  }

  await enqueueExecuteWorkflow(ids);

  const requestId = approvable[0]!.requestId;
  revalidatePath(`/workflows/${requestId}`);
  revalidatePath("/workflows");
  redirect(`/workflows/${requestId}`);
}

/** Cancel remaining draft actions on a request (no external side effects). */
export async function cancelWorkflowDraftsAction(formData: FormData): Promise<void> {
  const returnTo = backTo(formData);
  const requestId = String(formData.get("requestId") ?? "");
  if (!requestId) redirectWithError(returnTo, "missing request id");

  const { person } = await requirePerson();
  if (!person) redirectWithError(returnTo, "your account is not linked to a person record");

  await db()
    .update(tables.workflowActions)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(tables.workflowActions.requestId, requestId),
        eq(tables.workflowActions.status, "draft"),
      ),
    );
  await db()
    .update(tables.workflowSubtasks)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(tables.workflowSubtasks.requestId, requestId),
        eq(tables.workflowSubtasks.status, "proposed"),
      ),
    );
  await db()
    .update(tables.workflowRequests)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(
      and(
        eq(tables.workflowRequests.id, requestId),
        eq(tables.workflowRequests.status, "drafted"),
      ),
    );

  revalidatePath(`/workflows/${requestId}`);
  revalidatePath("/workflows");
  redirect(`/workflows/${requestId}`);
}

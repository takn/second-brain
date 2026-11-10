import { Check, RefreshCw, X } from "lucide-react";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Narrative } from "@/components/narrative";
import { ErrorBanner } from "@/components/reject-form";
import {
  approveWorkflowActionsAction,
  cancelWorkflowDraftsAction,
} from "@/lib/actions";
import { workflowRequestById } from "@/lib/queries";

export const dynamic = "force-dynamic";

function destPreview(dest: Record<string, unknown>): string {
  const parts: string[] = [];
  if (dest.jiraProjectKey) parts.push(`Jira ${String(dest.jiraProjectKey)}`);
  if (dest.assigneeEmail) parts.push(`assignee ${String(dest.assigneeEmail)}`);
  if (dest.slackChannel) parts.push(`Slack #${String(dest.slackChannel)}`);
  if (dest.slackUserId) parts.push(`Slack DM ${String(dest.slackUserId)}`);
  if (Array.isArray(dest.emailTo) && dest.emailTo.length) {
    parts.push(`email ${dest.emailTo.join(", ")}`);
  }
  if (dest.emailSubject) parts.push(`subject “${String(dest.emailSubject)}”`);
  return parts.length > 0 ? parts.join(" · ") : "destination TBD";
}

export default async function WorkflowDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const wf = await workflowRequestById(id);
  if (!wf) notFound();

  const draftActions = wf.actions.filter((a) => a.status === "draft");
  const pending = wf.status === "pending";
  const executing = wf.actions.some((a) => a.status === "approved" || a.status === "executing");

  return (
    <>
      {(pending || executing) && <AutoRefresh />}
      <ErrorBanner message={error} />
      <h1 className="page-title">{wf.request}</h1>
      <p className="page-subtitle">
        Requested by {wf.requestedByName ?? "unknown"} ·{" "}
        {wf.createdAt.toISOString().slice(0, 16).replace("T", " ")}
        {wf.draftedAt && ` · drafted ${wf.draftedAt.toISOString().slice(0, 16).replace("T", " ")}`}
        {" · "}
        <span className={`query-status query-status-${wf.status}`}>{wf.status}</span>
      </p>

      {pending && (
        <section className="card">
          <div className="query-pending">
            <RefreshCw size={16} strokeWidth={1.75} className="spin" />
            The Workflow agent is drafting a plan — this page refreshes itself.
          </div>
        </section>
      )}

      {wf.status === "failed" && (
        <section className="card">
          <div className="error-banner">
            The agent could not produce a plan{wf.error ? `: ${wf.error}` : ""}. Try rephrasing the
            request.
          </div>
        </section>
      )}

      {wf.summary && (
        <section className="card">
          <h2>Plan summary</h2>
          <Narrative body={wf.summary} citations={wf.citations} />
        </section>
      )}

      {wf.subtasks.length > 0 && (
        <section className="card">
          <h2>Sub-tasks</h2>
          <ul className="event-list">
            {wf.subtasks.map((s) => {
              const linked = wf.actions.filter((a) => a.subtaskId === s.id);
              const done = linked.length > 0 && linked.every((a) => a.status === "executed");
              const total = Math.max(linked.length, 1);
              const finished = linked.filter((a) => a.status === "executed").length;
              return (
                <li key={s.id} className="event-item">
                  <div>
                    <strong>{s.title}</strong>
                    {s.description && <div className="publish-note">{s.description}</div>}
                  </div>
                  <div className="event-meta">
                    <span>route: {s.route}</span>
                    {s.suggestedPersonName && <span>→ {s.suggestedPersonName}</span>}
                    <span className={`query-status query-status-${s.status}`}>{s.status}</span>
                    <span>
                      progress {done ? total : finished}/{total}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {wf.actions.length > 0 && (
        <section className="card">
          <h2>Outbound drafts</h2>
          <p className="publish-note">
            Approve individually or as a batch. Execution uses the scoped executor — credentials
            never enter the agent context.
          </p>

          {draftActions.length > 0 && (
            <form action={approveWorkflowActionsAction} className="workflow-approve-form">
              <input type="hidden" name="returnTo" value={`/workflows/${wf.id}`} />
              <ul className="event-list">
                {draftActions.map((a) => (
                  <li key={a.id} className="event-item workflow-draft">
                    <label className="workflow-draft-label">
                      <input type="checkbox" name="actionIds" value={a.id} defaultChecked />
                      <span>
                        <strong>
                          [{a.kind}] {a.title}
                        </strong>
                        <div className="event-meta">{destPreview(a.destination)}</div>
                        <pre className="workflow-preview">{a.body}</pre>
                        <div className="event-meta">
                          expires {a.expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                        </div>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="ask-form">
                <button type="submit" className="btn-small">
                  <Check size={14} strokeWidth={1.75} /> Approve selected
                </button>
              </div>
            </form>
          )}

          {draftActions.length > 0 && (
            <form action={cancelWorkflowDraftsAction} className="ask-form" style={{ marginTop: 12 }}>
              <input type="hidden" name="returnTo" value={`/workflows/${wf.id}`} />
              <input type="hidden" name="requestId" value={wf.id} />
              <button type="submit" className="btn-small btn-danger">
                <X size={14} strokeWidth={1.75} /> Cancel remaining drafts
              </button>
            </form>
          )}

          <ul className="event-list" style={{ marginTop: 16 }}>
            {wf.actions
              .filter((a) => a.status !== "draft")
              .map((a) => (
                <li key={a.id} className="event-item">
                  <div>
                    <strong>
                      [{a.kind}] {a.title}
                    </strong>
                    <div className="event-meta">{destPreview(a.destination)}</div>
                    {a.status === "executed" || a.status === "failed" ? (
                      <div className="publish-note">
                        {String(a.executionResult.detail ?? JSON.stringify(a.executionResult))}
                      </div>
                    ) : (
                      <pre className="workflow-preview">{a.body}</pre>
                    )}
                  </div>
                  <div className="event-meta">
                    <span className={`query-status query-status-${a.status}`}>{a.status}</span>
                    {a.approvedByName && (
                      <span>
                        approved by {a.approvedByName}
                        {a.approvedAt
                          ? ` · ${a.approvedAt.toISOString().slice(0, 16).replace("T", " ")}`
                          : ""}
                      </span>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        </section>
      )}
    </>
  );
}

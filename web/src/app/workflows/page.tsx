import { GitBranch } from "lucide-react";
import { AutoRefresh } from "@/components/auto-refresh";
import { ErrorBanner } from "@/components/reject-form";
import { startWorkflowAction } from "@/lib/actions";
import { getUser } from "@/lib/auth";
import { myWorkflowRequests, personByEmail } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const user = await getUser();
  const person = await personByEmail(user.email);
  const requests = person ? await myWorkflowRequests(person.id) : [];
  const anyPending = requests.some((r) => r.status === "pending");

  return (
    <>
      {anyPending && <AutoRefresh />}
      <ErrorBanner message={error} />
      <h1 className="page-title">Workflows</h1>
      <p className="page-subtitle">
        Ask in plain language for drafts — Jira tasks, Slack messages, emails, or documents.
        Nothing is sent or filed until you approve the full preview.
      </p>

      <section className="card">
        <form action={startWorkflowAction} className="ask-form">
          <textarea
            name="request"
            rows={4}
            maxLength={4000}
            required
            placeholder='e.g. "Let the interfaces team know the milestone slipped, and file a Jira follow-up for the POC"'
            className="ask-input"
          />
          <button type="submit" className="btn-small">
            <GitBranch size={14} strokeWidth={1.75} /> Draft plan
          </button>
        </form>
      </section>

      <section className="card">
        <h2>
          <GitBranch size={16} strokeWidth={1.75} /> Your requests
        </h2>
        {requests.length === 0 ? (
          <div className="empty-note">No workflow requests yet.</div>
        ) : (
          <ul className="event-list">
            {requests.map((r) => (
              <li key={r.id} className="event-item">
                <a href={`/workflows/${r.id}`}>{r.request}</a>
                <div className="event-meta">
                  <span className={`query-status query-status-${r.status}`}>{r.status}</span>
                  <span>{r.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

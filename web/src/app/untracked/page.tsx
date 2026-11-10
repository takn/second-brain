import { ListChecks, Plus } from "lucide-react";
import { CreatedIssueBanner, ErrorBanner } from "@/components/reject-form";
import { createIssueAction } from "@/lib/actions";
import { untrackedList } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function UntrackedPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string; board?: string; url?: string }>;
}) {
  const { error, created, board, url } = await searchParams;
  const rows = await untrackedList();

  return (
    <>
      <ErrorBanner message={error} />
      <CreatedIssueBanner created={created} board={board} url={url} />
      <h1 className="page-title">Untracked work</h1>
      <p className="page-subtitle">
        Action items the brain heard about that match no Jira issue or GitLab MR. One click files
        the Jira issue — nothing is created without a human deciding it.
      </p>

      <section className="card">
        <h2>
          <ListChecks size={16} strokeWidth={1.75} /> Open ({rows.length})
        </h2>
        {rows.length === 0 ? (
          <div className="empty-note">Nothing untracked — everything the brain sees is filed.</div>
        ) : (
          <ul className="event-list">
            {rows.map((u) => (
              <li key={u.id} className="event-item">
                <span>{u.title}</span>
                <div className="event-meta">
                  <a href={`/projects/${encodeURIComponent(u.projectSlug)}`}>{u.projectName}</a>
                  <span>{u.createdAt.toISOString().slice(0, 10)}</span>
                  {u.eventPermalink && <a href={u.eventPermalink}>source</a>}
                  <form action={createIssueAction} className="inline-form">
                    <input type="hidden" name="untrackedId" value={u.id} />
                    <input type="hidden" name="returnTo" value="/untracked" />
                    <button
                      type="submit"
                      className="btn-small"
                      title={`Creates a Jira Task in ${u.jiraProjectKey}`}
                    >
                      <Plus size={12} strokeWidth={2} /> Create in {u.jiraProjectKey}
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

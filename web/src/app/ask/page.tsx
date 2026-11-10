import { BookMarked, MessageCircleQuestion } from "lucide-react";
import { AutoRefresh } from "@/components/auto-refresh";
import { ErrorBanner } from "@/components/reject-form";
import { askBrainAction } from "@/lib/actions";
import { getUser } from "@/lib/auth";
import { myQueries, personByEmail, recentAnalyses } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const user = await getUser();
  const person = await personByEmail(user.email);
  const [queries, analyses] = await Promise.all([
    person ? myQueries(person.id) : Promise.resolve([]),
    recentAnalyses(),
  ]);
  const anyPending = queries.some((q) => q.status === "pending");

  return (
    <>
      {anyPending && <AutoRefresh />}
      <ErrorBanner message={error} />
      <h1 className="page-title">Ask the brain</h1>
      <p className="page-subtitle">
        The Query agent searches the knowledge base, drills into project state, and answers with
        citations — usually within a minute. Answers worth keeping can be saved as analyses.
      </p>

      <section className="card">
        <form action={askBrainAction} className="ask-form">
          <textarea
            name="question"
            rows={3}
            maxLength={2000}
            required
            placeholder="e.g. What's blocking the Sep 30 release?"
            className="ask-input"
          />
          <button type="submit" className="btn-small">
            <MessageCircleQuestion size={14} strokeWidth={1.75} /> Ask
          </button>
        </form>
      </section>

      <section className="card">
        <h2>
          <MessageCircleQuestion size={16} strokeWidth={1.75} /> Your questions
        </h2>
        {queries.length === 0 ? (
          <div className="empty-note">Nothing asked yet.</div>
        ) : (
          <ul className="event-list">
            {queries.map((q) => (
              <li key={q.id} className="event-item">
                <a href={`/ask/${q.id}`}>{q.question}</a>
                <div className="event-meta">
                  <span className={`query-status query-status-${q.status}`}>
                    {q.status === "pending" ? "thinking…" : q.status}
                  </span>
                  <span>{q.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                  {q.analysisId && <a href={`/analyses/${q.analysisId}`}>saved analysis</a>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {analyses.length > 0 && (
        <section className="card">
          <h2>
            <BookMarked size={16} strokeWidth={1.75} /> Saved analyses
          </h2>
          <ul className="event-list">
            {analyses.map((a) => (
              <li key={a.id} className="event-item">
                <a href={`/analyses/${a.id}`}>{a.title}</a>
                <div className="event-meta">
                  <span>{a.savedByName ?? "unknown"}</span>
                  <span>{a.createdAt.toISOString().slice(0, 10)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

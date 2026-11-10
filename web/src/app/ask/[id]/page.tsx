import { BookMarked, RefreshCw } from "lucide-react";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Narrative } from "@/components/narrative";
import { ErrorBanner } from "@/components/reject-form";
import { saveAnalysisAction } from "@/lib/actions";
import { brainQueryById } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function QueryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const query = await brainQueryById(id);
  if (!query) notFound();

  return (
    <>
      {query.status === "pending" && <AutoRefresh />}
      <ErrorBanner message={error} />
      <h1 className="page-title">{query.question}</h1>
      <p className="page-subtitle">
        Asked by {query.askedByName ?? "unknown"} ·{" "}
        {query.createdAt.toISOString().slice(0, 16).replace("T", " ")}
        {query.answeredAt && ` · answered ${query.answeredAt.toISOString().slice(0, 16).replace("T", " ")}`}
      </p>

      {query.status === "pending" && (
        <section className="card">
          <div className="query-pending">
            <RefreshCw size={16} strokeWidth={1.75} className="spin" />
            The Query agent is searching the brain — this page refreshes itself.
          </div>
        </section>
      )}

      {query.status === "failed" && (
        <section className="card">
          <div className="error-banner">
            The agent could not produce an answer{query.error ? `: ${query.error}` : ""}. Try
            rephrasing the question.
          </div>
        </section>
      )}

      {query.status === "answered" && query.answer && (
        <>
          <section className="card">
            <Narrative body={query.answer} citations={query.citations} />
          </section>

          {query.analysisId ? (
            <section className="card">
              <a href={`/analyses/${query.analysisId}`}>
                <BookMarked size={14} strokeWidth={1.75} /> View saved analysis
              </a>
            </section>
          ) : (
            <section className="card">
              <form action={saveAnalysisAction} className="save-analysis-form">
                <input type="hidden" name="queryId" value={query.id} />
                <input type="hidden" name="returnTo" value={`/ask/${query.id}`} />
                <input
                  type="text"
                  name="title"
                  required
                  maxLength={200}
                  placeholder="Analysis title…"
                  className="search-input"
                />
                <button type="submit" className="btn-small">
                  <BookMarked size={14} strokeWidth={1.75} /> Save as analysis
                </button>
              </form>
              <div className="publish-note">
                Saving files this answer as a first-class, searchable document.
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

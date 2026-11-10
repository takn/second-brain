import { FileText } from "lucide-react";
import { ErrorBanner } from "@/components/reject-form";
import { requestReportAction } from "@/lib/actions";
import { getUser } from "@/lib/auth";
import { allTeams, reportsList } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; queued?: string }>;
}) {
  const { error, queued } = await searchParams;
  const [user, reports, teams] = await Promise.all([getUser(), reportsList(), allTeams()]);

  return (
    <>
      <ErrorBanner message={error} />
      <h1 className="page-title">Reports</h1>
      <p className="page-subtitle">
        Point-in-time status snapshots the Reporter writes from current brain data — document plus
        slide outline, every claim cited. Reports stay drafts until a human publishes them.
      </p>

      {queued && (
        <div className="info-banner">
          Report queued — generation takes a minute or two; refresh to see it appear.
        </div>
      )}

      {user.role === "L1" && (
        <section className="card">
          <h2>Generate</h2>
          <div className="report-generate-row">
            <form action={requestReportAction}>
              <input type="hidden" name="scope" value="portfolio" />
              <input type="hidden" name="returnTo" value="/reports" />
              <button type="submit" className="btn-small">
                Portfolio report
              </button>
            </form>
            <form action={requestReportAction} className="report-team-form">
              <input type="hidden" name="scope" value="team" />
              <input type="hidden" name="returnTo" value="/reports" />
              <select name="teamId" defaultValue="">
                <option value="" disabled>
                  Pick a team…
                </option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn-small">
                Team report
              </button>
            </form>
          </div>
        </section>
      )}

      <section className="card">
        <h2>
          <FileText size={16} strokeWidth={1.75} /> All reports
        </h2>
        {reports.length === 0 ? (
          <div className="empty-note">No reports yet.</div>
        ) : (
          <ul className="event-list">
            {reports.map((r) => (
              <li key={r.id} className="event-item">
                <a href={`/reports/${r.id}`}>{r.title}</a>
                <div className="event-meta">
                  <span>{r.scope === "team" ? `${r.teamName ?? "team"}` : "portfolio"}</span>
                  <span className={`report-status report-status-${r.status}`}>{r.status}</span>
                  <span>{r.createdAt.toISOString().slice(0, 10)}</span>
                  <span>{r.requestedByName ? `requested by ${r.requestedByName}` : "scheduled"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

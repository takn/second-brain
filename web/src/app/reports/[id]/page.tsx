import { BadgeCheck, Presentation } from "lucide-react";
import { notFound } from "next/navigation";
import { Narrative } from "@/components/narrative";
import { ErrorBanner } from "@/components/reject-form";
import { publishReportAction } from "@/lib/actions";
import { getUser } from "@/lib/auth";
import { reportById } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const [user, report] = await Promise.all([getUser(), reportById(id)]);
  if (!report) notFound();

  return (
    <>
      <ErrorBanner message={error} />
      <div className="project-header">
        <h1 className="page-title">{report.title}</h1>
        <span className={`report-status report-status-${report.status}`}>{report.status}</span>
      </div>
      <p className="page-subtitle">
        {report.scope === "team" ? `${report.teamName ?? "Team"} report` : "Portfolio report"} ·
        generated {report.createdAt.toISOString().slice(0, 10)} by {report.createdBy}
        {report.requestedByName ? ` · requested by ${report.requestedByName}` : " · scheduled"}
        {report.publishedAt &&
          ` · published ${report.publishedAt.toISOString().slice(0, 10)}${report.publishedByName ? ` by ${report.publishedByName}` : ""}`}
      </p>

      {report.status === "draft" && user.role === "L1" && (
        <form action={publishReportAction} className="report-publish-bar">
          <input type="hidden" name="reportId" value={report.id} />
          <input type="hidden" name="returnTo" value={`/reports/${report.id}`} />
          <button type="submit" className="btn-small">
            <BadgeCheck size={14} strokeWidth={1.75} /> Publish
          </button>
          <span className="publish-note">
            Publishing marks this snapshot reviewed and distributable — it never happens
            automatically.
          </span>
        </form>
      )}

      <section className="card">
        <Narrative body={report.body} citations={report.citations} />
      </section>

      {report.slides.length > 0 && (
        <section className="card">
          <h2>
            <Presentation size={16} strokeWidth={1.75} /> Slide outline
          </h2>
          <div className="slide-grid">
            {report.slides.map((slide, i) => (
              <div key={i} className="slide-card">
                <div className="slide-number">{i + 1}</div>
                <h3>{slide.title}</h3>
                <ul>
                  {slide.bullets.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

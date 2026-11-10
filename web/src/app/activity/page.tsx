import { Activity } from "lucide-react";
import { ErrorBanner, RejectForm } from "@/components/reject-form";
import { activityFeed, allProjects } from "@/lib/queries";

export const dynamic = "force-dynamic";

const CONFIDENCE_THRESHOLD = Number(process.env.UNVERIFIED_BELOW ?? 0.5);

const TYPES = [
  "decision",
  "blocker_raised",
  "blocker_resolved",
  "status_change",
  "deadline_set",
  "deadline_slipped",
  "action_item",
  "milestone_update",
  "narrative",
];

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; type?: string; error?: string }>;
}) {
  const { project, type, error } = await searchParams;
  const [entries, projects] = await Promise.all([
    activityFeed({ projectId: project || undefined, type: type || undefined }),
    allProjects(),
  ]);
  const returnTo = `/activity${project || type ? `?${new URLSearchParams({ ...(project ? { project } : {}), ...(type ? { type } : {}) })}` : ""}`;

  return (
    <>
      <ErrorBanner message={error} />
      <h1 className="page-title">Activity</h1>
      <p className="page-subtitle">
        Everything the brain has applied — events and narrative updates, each traceable to its
        source. Rejecting removes the change and re-synthesizes.
      </p>

      <form method="get" className="filter-bar">
        <select name="project" defaultValue={project ?? ""}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select name="type" defaultValue={type ?? ""}>
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <button type="submit" className="btn-small">
          Filter
        </button>
      </form>

      <section className="card">
        <h2>
          <Activity size={16} strokeWidth={1.75} /> Feed
        </h2>
        {entries.length === 0 ? (
          <div className="empty-note">Nothing matches these filters.</div>
        ) : (
          <ul className="event-list">
            {entries.map((e) => {
              const unverified = e.confidence !== null && e.confidence < CONFIDENCE_THRESHOLD;
              return (
                <li key={`${e.kind}-${e.id}`} className={`event-item ${e.status === "superseded" ? "superseded" : ""}`}>
                  <div className="timeline-head">
                    <span className={`type-tag type-${e.type}`}>{e.type.replace(/_/g, " ")}</span>
                    <span
                      className={unverified ? "unverified" : undefined}
                      title={unverified ? `unverified — confidence ${e.confidence}` : undefined}
                    >
                      {e.title}
                    </span>
                    {e.status === "superseded" && <span className="superseded-tag">superseded</span>}
                  </div>
                  <div className="event-meta">
                    {e.projectSlug ? (
                      <a href={`/projects/${encodeURIComponent(e.projectSlug)}`}>
                        {e.projectNames.join(", ")}
                      </a>
                    ) : (
                      <span>{e.projectNames.join(", ") || "—"}</span>
                    )}
                    <span>{e.at.toISOString().slice(0, 16).replace("T", " ")}</span>
                    {e.permalink && <a href={e.permalink}>source</a>}
                    {e.rejectable && (
                      <RejectForm
                        target={e.kind === "event" ? "event" : "revision"}
                        id={e.id}
                        returnTo={returnTo}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

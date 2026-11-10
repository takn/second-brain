import { Gavel } from "lucide-react";
import { allProjects, decisionLog } from "@/lib/queries";

export const dynamic = "force-dynamic";

const CONFIDENCE_THRESHOLD = Number(process.env.UNVERIFIED_BELOW ?? 0.5);

export default async function DecisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; project?: string }>;
}) {
  const { q, project } = await searchParams;
  const [decisions, projects] = await Promise.all([
    decisionLog({ q: q || undefined, projectId: project || undefined }),
    allProjects(),
  ]);

  return (
    <>
      <h1 className="page-title">Decision log</h1>
      <p className="page-subtitle">
        Every decision the brain has extracted, searchable, each linking to where it was made.
      </p>

      <form method="get" className="filter-bar">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search decisions…"
          className="search-input"
        />
        <select name="project" defaultValue={project ?? ""}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn-small">
          Search
        </button>
      </form>

      <section className="card">
        <h2>
          <Gavel size={16} strokeWidth={1.75} /> Decisions
          {q && <span className="filter-note"> matching “{q}”</span>}
        </h2>
        {decisions.length === 0 ? (
          <div className="empty-note">No decisions found.</div>
        ) : (
          <ul className="event-list">
            {decisions.map((e) => {
              const unverified = e.confidence < CONFIDENCE_THRESHOLD;
              return (
                <li key={e.id} className="event-item">
                  <span
                    className={unverified ? "unverified" : undefined}
                    title={unverified ? `unverified — confidence ${e.confidence}` : undefined}
                  >
                    {e.title}
                  </span>
                  <div className="event-meta">
                    <span>{e.projectNames.join(", ") || "—"}</span>
                    <span>{(e.occurredAt ?? e.extractedAt).toISOString().slice(0, 10)}</span>
                    {e.permalink && <a href={e.permalink}>source</a>}
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

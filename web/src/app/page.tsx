import { AlertOctagon, CalendarClock, Gavel, Grid3x3, Star } from "lucide-react";
import {
  activeBlockers,
  criticalDates,
  highPriorityProjects,
  recentDecisions,
  statusMatrix,
  type EventItem,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

const CONFIDENCE_THRESHOLD = Number(process.env.UNVERIFIED_BELOW ?? 0.5);
/** Visible rows before expand; rest stay behind "Show N more". */
const PREVIEW_COUNT = 4;

function Chip({ p }: { p: { slug: string; name: string; status: string; priority: string; openContradictions: number } }) {
  return (
    <a className={`project-chip status-${p.status}`} href={`/projects/${encodeURIComponent(p.slug)}`}>
      <span className="status-dot" />
      {p.name}
      {p.priority !== "P2" && <span className="priority-tag">{p.priority}</span>}
      {p.openContradictions > 0 && (
        <span className="badge-contradiction" title="open contradictions">
          {p.openContradictions}
        </span>
      )}
    </a>
  );
}

function EventRow({ e }: { e: EventItem }) {
  return (
    <li className="event-item">
      <span
        className={e.confidence < CONFIDENCE_THRESHOLD ? "unverified" : undefined}
        title={e.confidence < CONFIDENCE_THRESHOLD ? `unverified — confidence ${e.confidence}` : undefined}
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
}

function ExpandableEventList({ events, empty }: { events: EventItem[]; empty: string }) {
  if (events.length === 0) return <div className="empty-note">{empty}</div>;

  const preview = events.slice(0, PREVIEW_COUNT);
  const rest = events.slice(PREVIEW_COUNT);

  return (
    <>
      <ul className="event-list">
        {preview.map((e) => (
          <EventRow key={e.id} e={e} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="event-expand">
          <summary>
            <span className="event-expand-closed">Show {rest.length} more</span>
            <span className="event-expand-open">Show less</span>
          </summary>
          <ul className="event-list">
            {rest.map((e) => (
              <EventRow key={e.id} e={e} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export default async function Portfolio() {
  const [matrix, priorities, blockers, decisions, dates] = await Promise.all([
    statusMatrix(),
    highPriorityProjects(),
    activeBlockers(),
    recentDecisions(),
    criticalDates(),
  ]);

  const projectCount = matrix.reduce((n, t) => n + t.projects.length, 0);

  return (
    <>
      <h1 className="page-title">Portfolio</h1>
      <p className="page-subtitle">
        Live view over {projectCount} projects across {matrix.length} teams — every claim traces to a
        source.
      </p>

      {priorities.length > 0 && (
        <section className="card dash-priorities">
          <h2>
            <Star size={16} strokeWidth={1.75} /> P0 / P1
          </h2>
          <div className="chip-row">
            {priorities.map((p) => (
              <Chip key={p.id} p={p} />
            ))}
          </div>
        </section>
      )}

      <div className="dash-board">
        <section className="card dash-rail dash-rail-blockers">
          <h2>
            <AlertOctagon size={16} strokeWidth={1.75} /> Active blockers
            {blockers.length > 0 && <span className="rail-count">{blockers.length}</span>}
          </h2>
          <ExpandableEventList events={blockers} empty="No active blockers." />
        </section>

        <section className="card dash-rail dash-rail-dates">
          <h2>
            <CalendarClock size={16} strokeWidth={1.75} /> Critical dates
            {dates.length > 0 && <span className="rail-count">{dates.length}</span>}
          </h2>
          <ExpandableEventList events={dates} empty="No tracked deadlines yet." />
        </section>

        <section className="card dash-rail dash-rail-decisions">
          <h2>
            <Gavel size={16} strokeWidth={1.75} /> Recent decisions
            {decisions.length > 0 && <span className="rail-count">{decisions.length}</span>}
          </h2>
          <ExpandableEventList events={decisions} empty="No decisions extracted yet." />
        </section>

        <section className="card dash-matrix">
          <h2>
            <Grid3x3 size={16} strokeWidth={1.75} /> Status matrix
          </h2>
          {matrix.map((team) => (
            <div key={team.id} className="team-block">
              <div className="team-name">{team.name}</div>
              <div className="chip-row">
                {team.projects.map((p) => (
                  <Chip key={p.id} p={p} />
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}

import {
  AlertTriangle,
  Bell,
  BellOff,
  ExternalLink,
  FileText,
  GitMerge,
  History,
  Link2,
  ListChecks,
  Plus,
  SearchCheck,
} from "lucide-react";
import { notFound } from "next/navigation";
import { Narrative, ProjectSources } from "@/components/narrative";
import { ProjectTabs } from "@/components/project-tabs";
import { CreatedIssueBanner, ErrorBanner, RejectForm } from "@/components/reject-form";
import { createIssueAction, toggleFollowAction } from "@/lib/actions";
import { getUser } from "@/lib/auth";
import {
  activePeopleForPicker,
  isFollowingProject,
  personByEmail,
  projectDetail,
  type TimelineEvent,
} from "@/lib/queries";
import { OwnershipForm, OwnershipReadOnly } from "@/components/ownership-form";
import { groupLintFindings, upstreamSentence } from "@/lib/project-zones";

export const dynamic = "force-dynamic";

const CONFIDENCE_THRESHOLD = Number(process.env.UNVERIFIED_BELOW ?? 0.5);
const BLOCKER_TYPES = new Set(["blocker_raised", "blocker_resolved"]);

function fmt(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

function TimelineRow({ e, returnTo }: { e: TimelineEvent; returnTo: string }) {
  const unverified = e.confidence < CONFIDENCE_THRESHOLD;
  return (
    <li id={`evt-${e.id}`} className={`event-item timeline-item ${e.status === "superseded" ? "superseded" : ""}`}>
      <div className="timeline-head">
        <span className={`type-tag type-${e.type}`}>{e.type.replace(/_/g, " ")}</span>
        <span className={unverified ? "unverified" : undefined} title={unverified ? `unverified — confidence ${e.confidence}` : undefined}>
          {e.title}
        </span>
        {e.status === "superseded" && <span className="superseded-tag">superseded</span>}
      </div>
      {e.body && <div className="event-body">{e.body}</div>}
      <div className="event-meta">
        <span>{fmt(e.occurredAt ?? e.extractedAt)}</span>
        {e.permalink && <a href={e.permalink}>source</a>}
        {e.workItem && (
          <a href={e.workItem.webUrl} target="_blank" rel="noopener noreferrer">
            {e.workItem.reference ?? "work item"}
          </a>
        )}
        {e.status === "active" && <RejectForm target="event" id={e.id} returnTo={returnTo} />}
      </div>
    </li>
  );
}

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; created?: string; board?: string; url?: string }>;
}) {
  const { slug } = await params;
  const { error, created, board, url } = await searchParams;
  const decoded = decodeURIComponent(slug);
  const detail = await projectDetail(decoded);
  if (!detail) notFound();
  const { project, narrative, revisions, timeline, blockers, untracked, contradictions, workItems, lintFindings, dependencies } = detail;
  const returnTo = `/projects/${encodeURIComponent(decoded)}`;

  // Follow state scopes the daily digest (task 5.9); POCs are covered implicitly.
  const person = await personByEmail((await getUser()).email);
  const following = person ? await isFollowingProject(person.id, project.id) : false;
  const isPoc = person ? [project.pocId, project.backupPocId].includes(person.id) : false;
  const canAssignOwnership = person?.orgLevel === "L1";
  const peopleForPicker = canAssignOwnership ? await activePeopleForPicker() : [];

  const sentence = upstreamSentence(lintFindings, dependencies);
  const lintGroups = groupLintFindings(lintFindings, sentence);

  const progressEvents = timeline.filter((e) => e.type !== "decision" && !BLOCKER_TYPES.has(e.type));
  const decisionEvents = timeline.filter((e) => e.type === "decision");
  const blockerEvents = timeline.filter((e) => BLOCKER_TYPES.has(e.type));
  const dependsOn = dependencies.filter((d) => d.direction === "depends_on");
  const dependedOnBy = dependencies.filter((d) => d.direction === "depended_on_by");
  const healthCount = lintFindings.length + contradictions.length;
  const progressCount = progressEvents.length + workItems.length + untracked.length;

  return (
    <>
      <ErrorBanner message={error} />
      <CreatedIssueBanner created={created} board={board} url={url} />
      <header className="situation-bar">
        <div className="situation-title-row">
          <h1 className="page-title">{project.name}</h1>
          <span className={`project-chip status-${project.status}`}>
            <span className="status-dot" /> {project.status}
          </span>
          <span className="priority-tag">{project.priority}</span>
          {person && !isPoc && (
            <form action={toggleFollowAction} className="follow-form">
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <button
                type="submit"
                className="btn-small"
                title={
                  following
                    ? "Stop receiving this project in your daily digest"
                    : "Get this project in your daily digest"
                }
              >
                {following ? <BellOff size={13} strokeWidth={1.75} /> : <Bell size={13} strokeWidth={1.75} />}
                {following ? "Unfollow" : "Follow"}
              </button>
            </form>
          )}
          {isPoc && (
            <span className="follow-note" title="POCs always receive their projects in the daily digest">
              in your digest (POC)
            </span>
          )}
        </div>
        <div className="situation-meta">
          {project.teamName && <span>{project.teamName}</span>}
          {canAssignOwnership ? (
            <OwnershipForm
              projectId={project.id}
              returnTo={returnTo}
              pocId={project.pocId}
              backupPocId={project.backupPocId}
              people={peopleForPicker}
            />
          ) : (
            <OwnershipReadOnly pocName={project.pocName} backupPocName={project.backupPocName} />
          )}
          {project.description && <span>{project.description}</span>}
        </div>
        {sentence && <p className="situation-upstream">{sentence}</p>}
      </header>

      <section className="project-narrative">
        <div className="project-narrative-head">
          <h2>
            <FileText size={16} strokeWidth={1.75} /> Narrative
          </h2>
          {narrative && (
            <div className="event-meta">
              <span>
                revision {narrative.revision} · {fmt(narrative.createdAt)}
              </span>
              <RejectForm target="revision" id={narrative.revisionId} returnTo={returnTo} label="Reject revision" />
            </div>
          )}
        </div>
        {narrative ? (
          <Narrative
            body={narrative.body}
            citations={narrative.citations}
            projectName={project.name}
            variant="sections"
            showCitations={false}
          />
        ) : (
          <div className="empty-note">No narrative synthesized yet.</div>
        )}
      </section>

      <ProjectTabs
        counts={{
          progress: progressCount,
          decisions: decisionEvents.length,
          blockers: blockers.length,
          dependencies: dependencies.length,
          health: healthCount,
        }}
        panels={{
          progress: (
            <>
              <h3>Timeline</h3>
              {progressEvents.length === 0 ? (
                <div className="empty-note">No progress events yet.</div>
              ) : (
                <ul className="event-list timeline">
                  {progressEvents.map((e) => (
                    <TimelineRow key={e.id} e={e} returnTo={returnTo} />
                  ))}
                </ul>
              )}

              {untracked.length > 0 && (
                <>
                  <h3>
                    <ListChecks size={14} strokeWidth={1.75} /> Untracked work
                  </h3>
                  <ul className="event-list">
                    {untracked.map((u) => (
                      <li key={u.id} className="event-item">
                        <span>{u.title}</span>
                        <div className="event-meta">
                          <span>{fmt(u.createdAt)}</span>
                          {u.eventPermalink && <a href={u.eventPermalink}>source</a>}
                          <form action={createIssueAction} className="inline-form">
                            <input type="hidden" name="untrackedId" value={u.id} />
                            <input type="hidden" name="returnTo" value={returnTo} />
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
                </>
              )}

              <details className="panel-details">
                <summary>
                  <GitMerge size={14} strokeWidth={1.75} /> Work items ({workItems.length})
                </summary>
                {workItems.length === 0 ? (
                  <div className="empty-note">No mirrored work items.</div>
                ) : (
                  <ul className="event-list">
                    {workItems.map((w) => (
                      <li key={w.id} className="event-item">
                        <div className="timeline-head">
                          <a
                            href={w.webUrl}
                            className="workitem-link"
                            target="_blank"
                            rel="noopener noreferrer"
                            title={w.title}
                          >
                            <span className="workitem-title">{w.title}</span>
                            <ExternalLink size={11} strokeWidth={2} />
                          </a>
                          {w.fromBrain && (
                            <span className="type-tag type-brain" title="Filed from untracked work by second-brain">
                              Brain
                            </span>
                          )}
                        </div>
                        <div className="event-meta">
                          {w.reference && <span>{w.reference}</span>}
                          <span>
                            {w.source} {w.kind}
                          </span>
                          <span>{w.state}</span>
                          <span>{fmt(w.sourceUpdatedAt)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </details>

              <details className="panel-details">
                <summary>
                  <History size={14} strokeWidth={1.75} /> Revision history ({revisions.length})
                </summary>
                {revisions.length === 0 ? (
                  <div className="empty-note">No revisions yet.</div>
                ) : (
                  <ul className="event-list">
                    {revisions.map((r) => (
                      <li key={r.id} className="event-item">
                        <span>
                          r{r.revision} {r.isCurrent && <strong>(current)</strong>}
                        </span>
                        <div className="event-meta">
                          <span>{fmt(r.createdAt)}</span>
                          <span>{r.createdBy}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </>
          ),
          decisions: (
            <>
              {decisionEvents.length === 0 ? (
                <div className="empty-note">No decisions recorded yet.</div>
              ) : (
                <ul className="event-list timeline">
                  {decisionEvents.map((e) => (
                    <TimelineRow key={e.id} e={e} returnTo={returnTo} />
                  ))}
                </ul>
              )}
            </>
          ),
          blockers: (
            <>
              {blockerEvents.length === 0 ? (
                <div className="empty-note">No blockers recorded.</div>
              ) : (
                <ul className="event-list timeline">
                  {blockerEvents.map((e) => (
                    <TimelineRow key={e.id} e={e} returnTo={returnTo} />
                  ))}
                </ul>
              )}
            </>
          ),
          dependencies: (
            <>
              {dependencies.length === 0 ? (
                <div className="empty-note">No recorded dependencies.</div>
              ) : (
                <>
                  <h3>
                    <Link2 size={14} strokeWidth={1.75} /> Depends on ({dependsOn.length})
                  </h3>
                  {dependsOn.length === 0 ? (
                    <div className="empty-note">This project does not depend on others.</div>
                  ) : (
                    <ul className="event-list">
                      {dependsOn.map((d) => (
                        <li key={d.id} className="event-item">
                          <div className="timeline-head">
                            <a href={`/projects/${encodeURIComponent(d.otherProjectSlug)}`}>
                              {d.otherProjectName}
                            </a>
                          </div>
                          <div className="event-body">{d.summary}</div>
                          <div className="event-meta">
                            <span>since {d.createdAt.toISOString().slice(0, 10)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3>
                    <Link2 size={14} strokeWidth={1.75} /> Depended on by ({dependedOnBy.length})
                  </h3>
                  {dependedOnBy.length === 0 ? (
                    <div className="empty-note">No other projects depend on this one.</div>
                  ) : (
                    <ul className="event-list">
                      {dependedOnBy.map((d) => (
                        <li key={d.id} className="event-item">
                          <div className="timeline-head">
                            <a href={`/projects/${encodeURIComponent(d.otherProjectSlug)}`}>
                              {d.otherProjectName}
                            </a>
                          </div>
                          <div className="event-body">{d.summary}</div>
                          <div className="event-meta">
                            <span>since {d.createdAt.toISOString().slice(0, 10)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          ),
          health: (
            <>
              {healthCount === 0 ? (
                <div className="empty-note">No health signals.</div>
              ) : (
                <>
                  {contradictions.length > 0 && (
                    <>
                      <h3>
                        <AlertTriangle size={14} strokeWidth={1.75} /> Contradictions
                      </h3>
                      <ul className="event-list">
                        {contradictions.map((c) => (
                          <li key={c.id} className="event-item">
                            <span>{c.summary}</span>
                            {c.resolution && <div className="event-body">Brain&apos;s read: {c.resolution}</div>}
                            <div className="event-meta">
                              {c.eventA && <a href={`#evt-${c.eventA.id}`}>claim A</a>}
                              {c.eventB && <a href={`#evt-${c.eventB.id}`}>claim B</a>}
                              <span>{fmt(c.createdAt)}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {lintFindings.length > 0 && (
                    <>
                      <h3>
                        <SearchCheck size={14} strokeWidth={1.75} /> Signals
                      </h3>
                      <ul className="event-list">
                        {lintGroups.map((group) => {
                          const lead = group.items[0];
                          if (!lead) return null;
                          return (
                            <li key={lead.id} className="event-item">
                              {group.detail && <div className="event-body">{group.detail}</div>}
                              {group.items.map((f) => (
                                <div key={f.id}>
                                  <div className="timeline-head">
                                    <span className="type-tag">{f.kind.replace(/_/g, " ")}</span>
                                    <span>{f.summary}</span>
                                  </div>
                                  <div className="event-meta">
                                    <span>first seen {f.createdAt.toISOString().slice(0, 10)}</span>
                                  </div>
                                </div>
                              ))}
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </>
              )}
            </>
          ),
        }}
      />

      {narrative && (
        <ProjectSources
          body={narrative.body}
          citations={narrative.citations}
          projectName={project.name}
        />
      )}
    </>
  );
}

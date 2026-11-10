import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { tables } from "@second-brain/schema";
import { CONNECTOR_SOURCES, type ConnectorSource } from "./connector-health";
import { db } from "./db";
import { jiraProjectForSlug, jiraSyncConfig } from "./jira";
import { presentSlackNames } from "./slack-names";

export interface ProjectChip {
  id: string;
  slug: string;
  name: string;
  status: string;
  priority: string;
  openContradictions: number;
  hasNarrative: boolean;
}

export interface TeamRow {
  id: string;
  name: string;
  projects: ProjectChip[];
}

/** Status matrix: teams × their projects, with contradiction badges. */
export async function statusMatrix(): Promise<TeamRow[]> {
  // Org teams only (seeded from GitLab with provenance); ad-hoc rows are noise.
  const teams = await db()
    .select()
    .from(tables.teams)
    .where(sql`${tables.teams.gitlabGroupId} is not null`)
    .orderBy(tables.teams.name);
  const projects = await db().select().from(tables.projects).orderBy(tables.projects.name);

  const contradictionCounts = await db()
    .select({
      projectId: tables.contradictions.projectId,
      n: sql<number>`count(*)::int`,
    })
    .from(tables.contradictions)
    .where(eq(tables.contradictions.status, "open"))
    .groupBy(tables.contradictions.projectId);
  const byProject = new Map(contradictionCounts.map((c) => [c.projectId, c.n]));

  const narratives = await db()
    .select({ projectId: tables.narratives.projectId })
    .from(tables.narratives)
    .where(sql`${tables.narratives.currentRevisionId} is not null`);
  const withNarrative = new Set(narratives.map((n) => n.projectId));

  return teams
    .map((t) => ({
      id: t.id,
      name: t.name,
      projects: projects
        .filter((p) => p.teamId === t.id)
        .map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          status: p.status,
          priority: p.priority,
          openContradictions: byProject.get(p.id) ?? 0,
          hasNarrative: withNarrative.has(p.id),
        })),
    }))
    .filter((t) => t.projects.length > 0);
}

export interface EventItem {
  id: string;
  type: string;
  title: string;
  confidence: number;
  occurredAt: Date | null;
  extractedAt: Date;
  permalink: string | null;
  projectNames: string[];
}

/** Portfolio rails fetch enough rows for expand-in-place; preview truncates in the UI. */
const PORTFOLIO_EVENT_LIMIT = 50;

async function eventsOfTypes(
  types: ("decision" | "blocker_raised" | "deadline_set" | "deadline_slipped")[],
  limit: number,
  order: "extracted_desc" | "occurred_asc" = "extracted_desc",
): Promise<EventItem[]> {
  const orderBy =
    order === "occurred_asc"
      ? asc(sql`coalesce(${tables.events.occurredAt}, ${tables.events.extractedAt})`)
      : desc(tables.events.extractedAt);

  const rows = await db()
    .select({
      id: tables.events.id,
      type: tables.events.type,
      title: tables.events.title,
      confidence: tables.events.confidence,
      occurredAt: tables.events.occurredAt,
      extractedAt: tables.events.extractedAt,
      permalink: tables.events.permalink,
    })
    .from(tables.events)
    .where(and(inArray(tables.events.type, types), eq(tables.events.status, "active")))
    .orderBy(orderBy)
    .limit(limit);
  if (rows.length === 0) return [];

  const links = await db()
    .select({
      eventId: tables.eventProjects.eventId,
      name: tables.projects.name,
    })
    .from(tables.eventProjects)
    .innerJoin(tables.projects, eq(tables.projects.id, tables.eventProjects.projectId))
    .where(
      inArray(
        tables.eventProjects.eventId,
        rows.map((r) => r.id),
      ),
    );
  const namesByEvent = new Map<string, string[]>();
  for (const l of links) {
    namesByEvent.set(l.eventId, [...(namesByEvent.get(l.eventId) ?? []), l.name]);
  }
  return presentSlackNames(rows.map((r) => ({ ...r, projectNames: namesByEvent.get(r.id) ?? [] })));
}

export const recentDecisions = () => eventsOfTypes(["decision"], PORTFOLIO_EVENT_LIMIT);
export const activeBlockers = () => eventsOfTypes(["blocker_raised"], PORTFOLIO_EVENT_LIMIT);
export const criticalDates = () =>
  eventsOfTypes(["deadline_set", "deadline_slipped"], PORTFOLIO_EVENT_LIMIT, "occurred_asc");

// --- Project detail (task 5.3) ---

export interface CitedEvent {
  id: string;
  type: string;
  title: string;
  permalink: string | null;
}

export interface RevisionMeta {
  id: string;
  revision: number;
  summary: string | null;
  createdBy: string;
  createdAt: Date;
  isCurrent: boolean;
}

export interface TimelineEvent extends EventItem {
  status: string;
  body: string | null;
  workItem: { reference: string | null; webUrl: string } | null;
}

export interface ContradictionRow {
  id: string;
  summary: string;
  resolution: string | null;
  createdAt: Date;
  eventA: CitedEvent | null;
  eventB: CitedEvent | null;
}

export interface UntrackedRow {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
  issueWebUrl: string | null;
  eventPermalink: string | null;
  projectName: string;
  projectSlug: string;
  /** Jira project key the one-click create will target (sync mapping). */
  jiraProjectKey: string;
}

export interface WorkItemRow {
  id: string;
  source: string;
  kind: string;
  reference: string | null;
  title: string;
  state: string;
  webUrl: string;
  sourceUpdatedAt: Date | null;
  /** Filed via brain one-click create from untracked work. */
  fromBrain: boolean;
}

export interface LintFindingRow {
  id: string;
  kind: string;
  summary: string;
  detail: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface DependencyRow {
  id: string;
  /** "depends_on": this project waits on the other; "depended_on_by": the reverse. */
  direction: "depends_on" | "depended_on_by";
  otherProjectName: string;
  otherProjectSlug: string;
  summary: string;
  createdAt: Date;
}

export interface ProjectDetail {
  project: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: string;
    priority: string;
    teamName: string | null;
    pocId: string | null;
    backupPocId: string | null;
    pocName: string | null;
    backupPocName: string | null;
  };
  narrative: {
    revisionId: string;
    revision: number;
    body: string;
    summary: string | null;
    createdAt: Date;
    citations: CitedEvent[];
  } | null;
  revisions: RevisionMeta[];
  timeline: TimelineEvent[];
  blockers: TimelineEvent[];
  untracked: UntrackedRow[];
  contradictions: ContradictionRow[];
  workItems: WorkItemRow[];
  lintFindings: LintFindingRow[];
  dependencies: DependencyRow[];
}

export async function projectDetail(slug: string): Promise<ProjectDetail | null> {
  const [project] = await db()
    .select()
    .from(tables.projects)
    .where(eq(tables.projects.slug, slug));
  if (!project) return null;

  const [team] = project.teamId
    ? await db().select().from(tables.teams).where(eq(tables.teams.id, project.teamId))
    : [];
  const pocIds = [project.pocId, project.backupPocId].filter((x): x is string => Boolean(x));
  const pocs = pocIds.length
    ? await db().select().from(tables.people).where(inArray(tables.people.id, pocIds))
    : [];
  const nameOf = (id: string | null) => pocs.find((p) => p.id === id)?.displayName ?? null;

  // Narrative head + its citations (provenance drill-down).
  const [narrative] = await db()
    .select()
    .from(tables.narratives)
    .where(and(eq(tables.narratives.projectId, project.id), eq(tables.narratives.kind, "status")));
  let narrativeDetail: ProjectDetail["narrative"] = null;
  let revisions: RevisionMeta[] = [];
  if (narrative) {
    const revRows = await db()
      .select()
      .from(tables.narrativeRevisions)
      .where(eq(tables.narrativeRevisions.narrativeId, narrative.id))
      .orderBy(desc(tables.narrativeRevisions.revision))
      .limit(10);
    revisions = revRows.map((r) => ({
      id: r.id,
      revision: r.revision,
      summary: r.summary,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      isCurrent: r.id === narrative.currentRevisionId,
    }));
    const head = revRows.find((r) => r.id === narrative.currentRevisionId);
    if (head) {
      const cites = await db()
        .select({
          id: tables.events.id,
          type: tables.events.type,
          title: tables.events.title,
          permalink: tables.events.permalink,
        })
        .from(tables.narrativeCitations)
        .innerJoin(tables.events, eq(tables.events.id, tables.narrativeCitations.eventId))
        .where(eq(tables.narrativeCitations.revisionId, head.id));
      narrativeDetail = {
        revisionId: head.id,
        revision: head.revision,
        body: head.body,
        summary: head.summary,
        createdAt: head.createdAt,
        citations: cites,
      };
    }
  }

  // Timeline: everything the brain believes about this project, newest first.
  const timelineRows = await db()
    .select({
      id: tables.events.id,
      type: tables.events.type,
      status: tables.events.status,
      title: tables.events.title,
      body: tables.events.body,
      confidence: tables.events.confidence,
      occurredAt: tables.events.occurredAt,
      extractedAt: tables.events.extractedAt,
      permalink: tables.events.permalink,
      workItemId: tables.events.workItemId,
    })
    .from(tables.events)
    .innerJoin(tables.eventProjects, eq(tables.eventProjects.eventId, tables.events.id))
    .where(
      and(
        eq(tables.eventProjects.projectId, project.id),
        inArray(tables.events.status, ["active", "superseded"]),
      ),
    )
    .orderBy(desc(tables.events.extractedAt))
    .limit(50);

  const workItemIds = timelineRows.map((r) => r.workItemId).filter((x): x is string => Boolean(x));
  const linkedItems = workItemIds.length
    ? await db().select().from(tables.workItems).where(inArray(tables.workItems.id, workItemIds))
    : [];
  const timeline: TimelineEvent[] = timelineRows.map((r) => {
    const wi = linkedItems.find((w) => w.id === r.workItemId);
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      title: r.title,
      body: r.body,
      confidence: r.confidence,
      occurredAt: r.occurredAt,
      extractedAt: r.extractedAt,
      permalink: r.permalink,
      projectNames: [],
      workItem: wi ? { reference: wi.reference, webUrl: wi.webUrl } : null,
    };
  });

  const untrackedRows = await db()
    .select({
      id: tables.untrackedWork.id,
      title: tables.untrackedWork.title,
      status: tables.untrackedWork.status,
      createdAt: tables.untrackedWork.createdAt,
      issueWebUrl: tables.untrackedWork.issueWebUrl,
      eventPermalink: tables.events.permalink,
    })
    .from(tables.untrackedWork)
    .innerJoin(tables.events, eq(tables.events.id, tables.untrackedWork.eventId))
    .where(
      and(
        eq(tables.untrackedWork.projectId, project.id),
        eq(tables.untrackedWork.status, "open"),
      ),
    )
    .orderBy(desc(tables.untrackedWork.createdAt));

  const contradictionRows = await db()
    .select()
    .from(tables.contradictions)
    .where(
      and(eq(tables.contradictions.projectId, project.id), eq(tables.contradictions.status, "open")),
    )
    .orderBy(desc(tables.contradictions.createdAt));
  const contraEventIds = contradictionRows.flatMap((c) => [c.eventAId, c.eventBId]);
  const contraEvents = contraEventIds.length
    ? await db()
        .select({
          id: tables.events.id,
          type: tables.events.type,
          title: tables.events.title,
          permalink: tables.events.permalink,
        })
        .from(tables.events)
        .where(inArray(tables.events.id, contraEventIds))
    : [];
  const eventById = new Map(contraEvents.map((e) => [e.id, e]));

  const workItemRows = await db()
    .select()
    .from(tables.workItems)
    .where(eq(tables.workItems.projectId, project.id))
    .orderBy(desc(tables.workItems.sourceUpdatedAt))
    .limit(15);

  // Provenance for the "Brain" badge: linked from a resolved untracked-work row.
  const brainFiled = await db()
    .select({ workItemId: tables.untrackedWork.workItemId })
    .from(tables.untrackedWork)
    .where(
      and(
        eq(tables.untrackedWork.projectId, project.id),
        eq(tables.untrackedWork.status, "issue_created"),
        isNotNull(tables.untrackedWork.workItemId),
      ),
    );
  const brainWorkItemIds = new Set(
    brainFiled.map((r) => r.workItemId).filter((id): id is string => Boolean(id)),
  );

  const [outbound, inbound] = await Promise.all([
    db()
      .select({
        id: tables.dependencies.id,
        summary: tables.dependencies.summary,
        createdAt: tables.dependencies.createdAt,
        otherProjectName: tables.projects.name,
        otherProjectSlug: tables.projects.slug,
      })
      .from(tables.dependencies)
      .innerJoin(tables.projects, eq(tables.projects.id, tables.dependencies.prerequisiteProjectId))
      .where(
        and(
          eq(tables.dependencies.dependentProjectId, project.id),
          eq(tables.dependencies.status, "open"),
        ),
      ),
    db()
      .select({
        id: tables.dependencies.id,
        summary: tables.dependencies.summary,
        createdAt: tables.dependencies.createdAt,
        otherProjectName: tables.projects.name,
        otherProjectSlug: tables.projects.slug,
      })
      .from(tables.dependencies)
      .innerJoin(tables.projects, eq(tables.projects.id, tables.dependencies.dependentProjectId))
      .where(
        and(
          eq(tables.dependencies.prerequisiteProjectId, project.id),
          eq(tables.dependencies.status, "open"),
        ),
      ),
  ]);
  const dependencyRows: DependencyRow[] = [
    ...outbound.map((d): DependencyRow => ({ ...d, direction: "depends_on" })),
    ...inbound.map((d): DependencyRow => ({ ...d, direction: "depended_on_by" })),
  ];

  const lintRows = await db()
    .select({
      id: tables.lintFindings.id,
      kind: tables.lintFindings.kind,
      summary: tables.lintFindings.summary,
      detail: tables.lintFindings.detail,
      createdAt: tables.lintFindings.createdAt,
      lastSeenAt: tables.lintFindings.lastSeenAt,
    })
    .from(tables.lintFindings)
    .where(
      and(eq(tables.lintFindings.projectId, project.id), eq(tables.lintFindings.status, "open")),
    )
    .orderBy(desc(tables.lintFindings.lastSeenAt))
    .limit(20);

  const jiraConfig = jiraSyncConfig();

  return presentSlackNames({
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      description: project.description,
      status: project.status,
      priority: project.priority,
      teamName: team?.name ?? null,
      pocId: project.pocId,
      backupPocId: project.backupPocId,
      pocName: nameOf(project.pocId),
      backupPocName: nameOf(project.backupPocId),
    },
    narrative: narrativeDetail,
    revisions,
    timeline,
    blockers: timeline.filter((e) => e.type === "blocker_raised" && e.status === "active"),
    untracked: untrackedRows.map((u) => ({
      ...u,
      projectName: project.name,
      projectSlug: project.slug,
      jiraProjectKey: jiraProjectForSlug(jiraConfig, project.slug),
    })),
    contradictions: contradictionRows.map((c) => ({
      id: c.id,
      summary: c.summary,
      resolution: c.resolution,
      createdAt: c.createdAt,
      eventA: eventById.get(c.eventAId) ?? null,
      eventB: eventById.get(c.eventBId) ?? null,
    })),
    workItems: workItemRows.map((w) => {
      const labels = Array.isArray(w.labels) ? (w.labels as unknown[]) : [];
      const labeledBrain = labels.includes("brain-untracked");
      return {
        id: w.id,
        source: w.source,
        kind: w.kind,
        reference: w.reference,
        title: w.title,
        state: w.state,
        webUrl: w.webUrl,
        sourceUpdatedAt: w.sourceUpdatedAt,
        fromBrain: brainWorkItemIds.has(w.id) || labeledBrain,
      };
    }),
    lintFindings: lintRows,
    dependencies: dependencyRows,
  });
}

// --- Activity feed (task 5.4) ---

export interface FeedEntry {
  kind: "event" | "narrative_revision";
  id: string;
  at: Date;
  title: string;
  type: string; // event type, or "narrative"
  status: string;
  confidence: number | null;
  permalink: string | null;
  projectNames: string[];
  projectSlug: string | null;
  /** Rejectable = active event, or narrative head revision. */
  rejectable: boolean;
}

export interface FeedFilters {
  projectId?: string;
  type?: string;
}

export async function activityFeed(filters: FeedFilters): Promise<FeedEntry[]> {
  const conditions = [inArray(tables.events.status, ["active", "superseded"])];
  if (filters.type && filters.type !== "narrative") {
    conditions.push(
      eq(tables.events.type, filters.type as (typeof tables.events.$inferSelect)["type"]),
    );
  }

  let eventRows: {
    id: string;
    type: string;
    status: string;
    title: string;
    confidence: number;
    extractedAt: Date;
    permalink: string | null;
  }[] = [];
  if (filters.type !== "narrative") {
    const base = db()
      .selectDistinct({
        id: tables.events.id,
        type: tables.events.type,
        status: tables.events.status,
        title: tables.events.title,
        confidence: tables.events.confidence,
        extractedAt: tables.events.extractedAt,
        permalink: tables.events.permalink,
      })
      .from(tables.events)
      .innerJoin(tables.eventProjects, eq(tables.eventProjects.eventId, tables.events.id));
    eventRows = await base
      .where(
        and(
          ...conditions,
          ...(filters.projectId ? [eq(tables.eventProjects.projectId, filters.projectId)] : []),
        ),
      )
      .orderBy(desc(tables.events.extractedAt))
      .limit(50);
  }

  const links = eventRows.length
    ? await db()
        .select({
          eventId: tables.eventProjects.eventId,
          name: tables.projects.name,
          slug: tables.projects.slug,
        })
        .from(tables.eventProjects)
        .innerJoin(tables.projects, eq(tables.projects.id, tables.eventProjects.projectId))
        .where(
          inArray(
            tables.eventProjects.eventId,
            eventRows.map((r) => r.id),
          ),
        )
    : [];
  const namesByEvent = new Map<string, { name: string; slug: string }[]>();
  for (const l of links) {
    namesByEvent.set(l.eventId, [
      ...(namesByEvent.get(l.eventId) ?? []),
      { name: l.name, slug: l.slug },
    ]);
  }

  const entries: FeedEntry[] = eventRows.map((r) => ({
    kind: "event",
    id: r.id,
    at: r.extractedAt,
    title: r.title,
    type: r.type,
    status: r.status,
    confidence: r.confidence,
    permalink: r.permalink,
    projectNames: (namesByEvent.get(r.id) ?? []).map((p) => p.name),
    projectSlug: namesByEvent.get(r.id)?.[0]?.slug ?? null,
    rejectable: r.status === "active",
  }));

  // Narrative updates are brain-applied changes too (web-app spec).
  if (!filters.type || filters.type === "narrative") {
    const revRows = await db()
      .select({
        id: tables.narrativeRevisions.id,
        revision: tables.narrativeRevisions.revision,
        summary: tables.narrativeRevisions.summary,
        createdAt: tables.narrativeRevisions.createdAt,
        currentRevisionId: tables.narratives.currentRevisionId,
        projectName: tables.projects.name,
        projectSlug: tables.projects.slug,
        projectId: tables.narratives.projectId,
      })
      .from(tables.narrativeRevisions)
      .innerJoin(
        tables.narratives,
        eq(tables.narratives.id, tables.narrativeRevisions.narrativeId),
      )
      .innerJoin(tables.projects, eq(tables.projects.id, tables.narratives.projectId))
      .where(filters.projectId ? eq(tables.narratives.projectId, filters.projectId) : undefined)
      .orderBy(desc(tables.narrativeRevisions.createdAt))
      .limit(20);
    for (const r of revRows) {
      entries.push({
        kind: "narrative_revision",
        id: r.id,
        at: r.createdAt,
        title: r.summary ?? `Narrative revision ${r.revision} — ${r.projectName}`,
        type: "narrative",
        status: r.id === r.currentRevisionId ? "current" : "superseded",
        confidence: null,
        permalink: null,
        projectNames: [r.projectName],
        projectSlug: r.projectSlug,
        rejectable: r.id === r.currentRevisionId,
      });
    }
  }

  return presentSlackNames(entries.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 50));
}

/** All projects, for filter dropdowns. */
export async function allProjects(): Promise<{ id: string; slug: string; name: string }[]> {
  return db()
    .select({ id: tables.projects.id, slug: tables.projects.slug, name: tables.projects.name })
    .from(tables.projects)
    .orderBy(tables.projects.name);
}

// --- Decision log (task 5.5) ---

export async function decisionLog(filters: {
  q?: string;
  projectId?: string;
}): Promise<EventItem[]> {
  const conditions = [eq(tables.events.type, "decision"), eq(tables.events.status, "active")];
  if (filters.q) {
    conditions.push(
      sql`to_tsvector('english', ${tables.events.title} || ' ' || coalesce(${tables.events.body}, '')) @@ websearch_to_tsquery('english', ${filters.q})`,
    );
  }
  const rows = await db()
    .selectDistinct({
      id: tables.events.id,
      type: tables.events.type,
      title: tables.events.title,
      confidence: tables.events.confidence,
      occurredAt: tables.events.occurredAt,
      extractedAt: tables.events.extractedAt,
      permalink: tables.events.permalink,
    })
    .from(tables.events)
    .innerJoin(tables.eventProjects, eq(tables.eventProjects.eventId, tables.events.id))
    .where(
      and(
        ...conditions,
        ...(filters.projectId ? [eq(tables.eventProjects.projectId, filters.projectId)] : []),
      ),
    )
    .orderBy(desc(tables.events.extractedAt))
    .limit(100);
  if (rows.length === 0) return [];
  const links = await db()
    .select({ eventId: tables.eventProjects.eventId, name: tables.projects.name })
    .from(tables.eventProjects)
    .innerJoin(tables.projects, eq(tables.projects.id, tables.eventProjects.projectId))
    .where(
      inArray(
        tables.eventProjects.eventId,
        rows.map((r) => r.id),
      ),
    );
  const namesByEvent = new Map<string, string[]>();
  for (const l of links) {
    namesByEvent.set(l.eventId, [...(namesByEvent.get(l.eventId) ?? []), l.name]);
  }
  return presentSlackNames(rows.map((r) => ({ ...r, projectNames: namesByEvent.get(r.id) ?? [] })));
}

// --- Fast search (task 5.6) ---

export interface SearchHit {
  kind: "project" | "person" | "event" | "narrative" | "analysis";
  id: string;
  title: string;
  snippet: string | null;
  href: string | null;
  meta: string | null;
}

export async function searchAll(q: string): Promise<SearchHit[]> {
  const query = q.trim();
  if (!query) return [];
  const ts = (expr: ReturnType<typeof sql>) =>
    sql`${expr} @@ websearch_to_tsquery('english', ${query})`;

  const [projectHits, peopleHits, eventHits, narrativeHits, analysisHits] = await Promise.all([
    db()
      .select()
      .from(tables.projects)
      .where(
        ts(
          sql`to_tsvector('english', ${tables.projects.name} || ' ' || coalesce(${tables.projects.description}, ''))`,
        ),
      )
      .limit(5),
    db()
      .select()
      .from(tables.people)
      .where(
        ts(
          sql`to_tsvector('english', ${tables.people.displayName} || ' ' || coalesce(${tables.people.email}, ''))`,
        ),
      )
      .limit(5),
    db()
      .select({
        id: tables.events.id,
        type: tables.events.type,
        title: tables.events.title,
        body: tables.events.body,
        permalink: tables.events.permalink,
        extractedAt: tables.events.extractedAt,
      })
      .from(tables.events)
      .where(
        and(
          eq(tables.events.status, "active"),
          ts(
            sql`to_tsvector('english', ${tables.events.title} || ' ' || coalesce(${tables.events.body}, ''))`,
          ),
        ),
      )
      .orderBy(desc(tables.events.extractedAt))
      .limit(10),
    db()
      .select({
        id: tables.narrativeRevisions.id,
        summary: tables.narrativeRevisions.summary,
        body: tables.narrativeRevisions.body,
        projectName: tables.projects.name,
        projectSlug: tables.projects.slug,
        currentRevisionId: tables.narratives.currentRevisionId,
      })
      .from(tables.narrativeRevisions)
      .innerJoin(
        tables.narratives,
        eq(tables.narratives.id, tables.narrativeRevisions.narrativeId),
      )
      .innerJoin(tables.projects, eq(tables.projects.id, tables.narratives.projectId))
      .where(
        and(
          sql`${tables.narrativeRevisions.id} = ${tables.narratives.currentRevisionId}`,
          ts(
            sql`to_tsvector('english', coalesce(${tables.narrativeRevisions.summary}, '') || ' ' || ${tables.narrativeRevisions.body})`,
          ),
        ),
      )
      .limit(5),
    db()
      .select({
        id: tables.analyses.id,
        title: tables.analyses.title,
        body: tables.analyses.body,
        createdAt: tables.analyses.createdAt,
      })
      .from(tables.analyses)
      .where(
        ts(sql`to_tsvector('english', ${tables.analyses.title} || ' ' || ${tables.analyses.body})`),
      )
      .orderBy(desc(tables.analyses.createdAt))
      .limit(5),
  ]);

  return presentSlackNames([
    ...projectHits.map(
      (p): SearchHit => ({
        kind: "project",
        id: p.id,
        title: p.name,
        snippet: p.description,
        href: `/projects/${encodeURIComponent(p.slug)}`,
        meta: `${p.priority} · ${p.status}`,
      }),
    ),
    ...peopleHits.map(
      (p): SearchHit => ({
        kind: "person",
        id: p.id,
        title: p.displayName,
        snippet: p.email,
        href: null,
        meta: p.orgLevel,
      }),
    ),
    ...eventHits.map(
      (e): SearchHit => ({
        kind: "event",
        id: e.id,
        title: e.title,
        snippet: e.body ? e.body.slice(0, 160) : null,
        href: e.permalink,
        meta: e.type.replace(/_/g, " "),
      }),
    ),
    ...narrativeHits.map(
      (n): SearchHit => ({
        kind: "narrative",
        id: n.id,
        title: `${n.projectName} — status narrative`,
        snippet: (n.summary ?? n.body).slice(0, 160),
        href: `/projects/${encodeURIComponent(n.projectSlug)}`,
        meta: "current revision",
      }),
    ),
    ...analysisHits.map(
      (a): SearchHit => ({
        kind: "analysis",
        id: a.id,
        title: a.title,
        snippet: a.body.slice(0, 160),
        href: `/analyses/${a.id}`,
        meta: `saved analysis · ${a.createdAt.toISOString().slice(0, 10)}`,
      }),
    ),
  ]);
}

// --- Untracked work (task 5.8) ---

export async function untrackedList(): Promise<UntrackedRow[]> {
  const rows = await db()
    .select({
      id: tables.untrackedWork.id,
      title: tables.untrackedWork.title,
      status: tables.untrackedWork.status,
      createdAt: tables.untrackedWork.createdAt,
      issueWebUrl: tables.untrackedWork.issueWebUrl,
      eventPermalink: tables.events.permalink,
      projectName: tables.projects.name,
      projectSlug: tables.projects.slug,
    })
    .from(tables.untrackedWork)
    .innerJoin(tables.events, eq(tables.events.id, tables.untrackedWork.eventId))
    .innerJoin(tables.projects, eq(tables.projects.id, tables.untrackedWork.projectId))
    .where(eq(tables.untrackedWork.status, "open"))
    .orderBy(desc(tables.untrackedWork.createdAt));
  const config = jiraSyncConfig();
  return presentSlackNames(
    rows.map((r) => ({
      ...r,
      jiraProjectKey: jiraProjectForSlug(config, r.projectSlug),
    })),
  );
}

/** The person record behind the SSO identity, for authorization checks. */
/** Whether a person follows a project (task 5.9 digest opt-in). */
export async function isFollowingProject(personId: string, projectId: string): Promise<boolean> {
  const [row] = await db()
    .select({ projectId: tables.projectFollows.projectId })
    .from(tables.projectFollows)
    .where(
      and(
        eq(tables.projectFollows.personId, personId),
        eq(tables.projectFollows.projectId, projectId),
      ),
    );
  return Boolean(row);
}

export async function personByEmail(email: string) {
  const [person] = await db()
    .select()
    .from(tables.people)
    .where(sql`lower(${tables.people.email}) = ${email.toLowerCase()}`);
  return person ?? null;
}

/** Active people for the project POC / backup picker (project-ownership). */
export async function activePeopleForPicker(): Promise<
  { id: string; displayName: string; email: string | null }[]
> {
  return db()
    .select({
      id: tables.people.id,
      displayName: tables.people.displayName,
      email: tables.people.email,
    })
    .from(tables.people)
    .where(eq(tables.people.active, true))
    .orderBy(asc(tables.people.displayName));
}

// --- Reports (task 4.8) ---

export interface ReportListRow {
  id: string;
  scope: "portfolio" | "team";
  teamName: string | null;
  title: string;
  status: "draft" | "published";
  createdAt: Date;
  requestedByName: string | null;
}

export interface ReportSlide {
  title: string;
  bullets: string[];
}

export interface ReportDetail {
  id: string;
  scope: "portfolio" | "team";
  teamName: string | null;
  title: string;
  body: string;
  slides: ReportSlide[];
  status: "draft" | "published";
  createdAt: Date;
  createdBy: string;
  requestedByName: string | null;
  publishedAt: Date | null;
  publishedByName: string | null;
  citations: CitedEvent[];
}

export async function reportsList(): Promise<ReportListRow[]> {
  const requester = alias(tables.people, "requester");
  return db()
    .select({
      id: tables.reports.id,
      scope: tables.reports.scope,
      teamName: tables.teams.name,
      title: tables.reports.title,
      status: tables.reports.status,
      createdAt: tables.reports.createdAt,
      requestedByName: requester.displayName,
    })
    .from(tables.reports)
    .leftJoin(tables.teams, eq(tables.teams.id, tables.reports.teamId))
    .leftJoin(requester, eq(requester.id, tables.reports.requestedById))
    .orderBy(desc(tables.reports.createdAt))
    .limit(100);
}

export async function reportById(id: string): Promise<ReportDetail | null> {
  const requester = alias(tables.people, "requester");
  const publisher = alias(tables.people, "publisher");
  const [row] = await db()
    .select({
      id: tables.reports.id,
      scope: tables.reports.scope,
      teamName: tables.teams.name,
      title: tables.reports.title,
      body: tables.reports.body,
      slides: tables.reports.slides,
      citedEventIds: tables.reports.citedEventIds,
      status: tables.reports.status,
      createdAt: tables.reports.createdAt,
      createdBy: tables.reports.createdBy,
      requestedByName: requester.displayName,
      publishedAt: tables.reports.publishedAt,
      publishedByName: publisher.displayName,
    })
    .from(tables.reports)
    .leftJoin(tables.teams, eq(tables.teams.id, tables.reports.teamId))
    .leftJoin(requester, eq(requester.id, tables.reports.requestedById))
    .leftJoin(publisher, eq(publisher.id, tables.reports.publishedById))
    .where(eq(tables.reports.id, id));
  if (!row) return null;

  const citedIds = (row.citedEventIds as string[]) ?? [];
  const citations: CitedEvent[] = citedIds.length
    ? await db()
        .select({
          id: tables.events.id,
          type: tables.events.type,
          title: tables.events.title,
          permalink: tables.events.permalink,
        })
        .from(tables.events)
        .where(inArray(tables.events.id, citedIds))
    : [];

  return presentSlackNames({
    ...row,
    slides: (row.slides as ReportSlide[]) ?? [],
    citations,
  });
}

// --- Ask the brain (task 5.7) ---

export interface BrainQueryRow {
  id: string;
  question: string;
  status: "pending" | "answered" | "failed";
  createdAt: Date;
  answeredAt: Date | null;
  analysisId: string | null;
}

export interface BrainQueryDetail extends BrainQueryRow {
  answer: string | null;
  error: string | null;
  answeredBy: string | null;
  askedByName: string | null;
  citations: CitedEvent[];
}

export async function myQueries(personId: string): Promise<BrainQueryRow[]> {
  return db()
    .select({
      id: tables.brainQueries.id,
      question: tables.brainQueries.question,
      status: tables.brainQueries.status,
      createdAt: tables.brainQueries.createdAt,
      answeredAt: tables.brainQueries.answeredAt,
      analysisId: tables.analyses.id,
    })
    .from(tables.brainQueries)
    .leftJoin(tables.analyses, eq(tables.analyses.queryId, tables.brainQueries.id))
    .where(eq(tables.brainQueries.askedById, personId))
    .orderBy(desc(tables.brainQueries.createdAt))
    .limit(50);
}

export async function brainQueryById(id: string): Promise<BrainQueryDetail | null> {
  const [row] = await db()
    .select({
      id: tables.brainQueries.id,
      question: tables.brainQueries.question,
      status: tables.brainQueries.status,
      answer: tables.brainQueries.answer,
      error: tables.brainQueries.error,
      answeredBy: tables.brainQueries.answeredBy,
      citedEventIds: tables.brainQueries.citedEventIds,
      createdAt: tables.brainQueries.createdAt,
      answeredAt: tables.brainQueries.answeredAt,
      askedByName: tables.people.displayName,
      analysisId: tables.analyses.id,
    })
    .from(tables.brainQueries)
    .innerJoin(tables.people, eq(tables.people.id, tables.brainQueries.askedById))
    .leftJoin(tables.analyses, eq(tables.analyses.queryId, tables.brainQueries.id))
    .where(eq(tables.brainQueries.id, id));
  if (!row) return null;

  const citedIds = (row.citedEventIds as string[]) ?? [];
  const citations: CitedEvent[] = citedIds.length
    ? await db()
        .select({
          id: tables.events.id,
          type: tables.events.type,
          title: tables.events.title,
          permalink: tables.events.permalink,
        })
        .from(tables.events)
        .where(inArray(tables.events.id, citedIds))
    : [];
  return presentSlackNames({ ...row, citations });
}

export interface AnalysisDetail {
  id: string;
  title: string;
  body: string;
  question: string;
  savedByName: string | null;
  createdAt: Date;
  citations: CitedEvent[];
}

export async function analysisById(id: string): Promise<AnalysisDetail | null> {
  const [row] = await db()
    .select({
      id: tables.analyses.id,
      title: tables.analyses.title,
      body: tables.analyses.body,
      citedEventIds: tables.analyses.citedEventIds,
      createdAt: tables.analyses.createdAt,
      question: tables.brainQueries.question,
      savedByName: tables.people.displayName,
    })
    .from(tables.analyses)
    .innerJoin(tables.brainQueries, eq(tables.brainQueries.id, tables.analyses.queryId))
    .innerJoin(tables.people, eq(tables.people.id, tables.analyses.savedById))
    .where(eq(tables.analyses.id, id));
  if (!row) return null;

  const citedIds = (row.citedEventIds as string[]) ?? [];
  const citations: CitedEvent[] = citedIds.length
    ? await db()
        .select({
          id: tables.events.id,
          type: tables.events.type,
          title: tables.events.title,
          permalink: tables.events.permalink,
        })
        .from(tables.events)
        .where(inArray(tables.events.id, citedIds))
    : [];
  return presentSlackNames({ ...row, citations });
}

export async function recentAnalyses(): Promise<
  { id: string; title: string; savedByName: string | null; createdAt: Date }[]
> {
  const rows = await db()
    .select({
      id: tables.analyses.id,
      title: tables.analyses.title,
      savedByName: tables.people.displayName,
      createdAt: tables.analyses.createdAt,
    })
    .from(tables.analyses)
    .innerJoin(tables.people, eq(tables.people.id, tables.analyses.savedById))
    .orderBy(desc(tables.analyses.createdAt))
    .limit(20);
  return presentSlackNames(rows);
}

/** All teams, for the team-report scope picker. */
export async function allTeams(): Promise<{ id: string; name: string }[]> {
  return db()
    .select({ id: tables.teams.id, name: tables.teams.name })
    .from(tables.teams)
    .orderBy(tables.teams.name);
}

// --- Connector observability (add-connector-status) ---

export interface SyncRunRow {
  id: string;
  source: string;
  status: "ok" | "failed";
  counts: Record<string, unknown>;
  error: string | null;
  startedAt: Date;
  durationMs: number;
}

/**
 * Latest runs per connector source, newest first, one round trip.
 * Sources with no runs are present with an empty array so the status page
 * can render every known connector (never-synced state included).
 */
export async function connectorRuns(limit = 10): Promise<Map<ConnectorSource, SyncRunRow[]>> {
  const ranked = db()
    .select({
      id: tables.syncRuns.id,
      source: tables.syncRuns.source,
      status: tables.syncRuns.status,
      counts: tables.syncRuns.counts,
      error: tables.syncRuns.error,
      startedAt: tables.syncRuns.startedAt,
      durationMs: tables.syncRuns.durationMs,
      rn: sql<number>`row_number() over (partition by ${tables.syncRuns.source} order by ${tables.syncRuns.startedAt} desc)`.as(
        "rn",
      ),
    })
    .from(tables.syncRuns)
    .as("ranked");
  const rows = await db()
    .select()
    .from(ranked)
    .where(sql`${ranked.rn} <= ${limit}`)
    .orderBy(ranked.source, desc(ranked.startedAt));

  const bySource = new Map<ConnectorSource, SyncRunRow[]>(
    CONNECTOR_SOURCES.map((s) => [s, []]),
  );
  for (const { rn: _rn, ...run } of rows) {
    bySource.get(run.source as ConnectorSource)?.push({
      ...run,
      counts: run.counts as Record<string, unknown>,
    });
  }
  return bySource;
}

/** P0/P1 projects for the priorities rail. */
export async function highPriorityProjects(): Promise<ProjectChip[]> {
  const rows = await db()
    .select()
    .from(tables.projects)
    .where(inArray(tables.projects.priority, ["P0", "P1"]))
    .orderBy(tables.projects.priority, tables.projects.name);
  return rows.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    status: p.status,
    priority: p.priority,
    openContradictions: 0,
    hasNarrative: false,
  }));
}

// --- Agent workflows (task 6.x) ---

export interface WorkflowRequestRow {
  id: string;
  request: string;
  status: string;
  createdAt: Date;
  draftedAt: Date | null;
  completedAt: Date | null;
}

export async function myWorkflowRequests(personId: string): Promise<WorkflowRequestRow[]> {
  return db()
    .select({
      id: tables.workflowRequests.id,
      request: tables.workflowRequests.request,
      status: tables.workflowRequests.status,
      createdAt: tables.workflowRequests.createdAt,
      draftedAt: tables.workflowRequests.draftedAt,
      completedAt: tables.workflowRequests.completedAt,
    })
    .from(tables.workflowRequests)
    .where(eq(tables.workflowRequests.requestedById, personId))
    .orderBy(desc(tables.workflowRequests.createdAt))
    .limit(50);
}

export interface WorkflowActionRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  destination: Record<string, unknown>;
  status: string;
  citedEventIds: unknown;
  approvedByName: string | null;
  approvedAt: Date | null;
  executedAt: Date | null;
  executionResult: Record<string, unknown>;
  expiresAt: Date;
  subtaskId: string | null;
}

export interface WorkflowSubtaskRow {
  id: string;
  sortOrder: number;
  title: string;
  description: string;
  route: string;
  status: string;
  suggestedPersonName: string | null;
}

export interface WorkflowRequestDetail {
  id: string;
  request: string;
  status: string;
  summary: string | null;
  error: string | null;
  createdAt: Date;
  draftedAt: Date | null;
  completedAt: Date | null;
  requestedByName: string | null;
  citations: CitedEvent[];
  subtasks: WorkflowSubtaskRow[];
  actions: WorkflowActionRow[];
}

export async function workflowRequestById(id: string): Promise<WorkflowRequestDetail | null> {
  const [row] = await db()
    .select({
      id: tables.workflowRequests.id,
      request: tables.workflowRequests.request,
      status: tables.workflowRequests.status,
      summary: tables.workflowRequests.summary,
      error: tables.workflowRequests.error,
      citedEventIds: tables.workflowRequests.citedEventIds,
      createdAt: tables.workflowRequests.createdAt,
      draftedAt: tables.workflowRequests.draftedAt,
      completedAt: tables.workflowRequests.completedAt,
      requestedByName: tables.people.displayName,
    })
    .from(tables.workflowRequests)
    .innerJoin(tables.people, eq(tables.people.id, tables.workflowRequests.requestedById))
    .where(eq(tables.workflowRequests.id, id));
  if (!row) return null;

  const [subtasks, actions] = await Promise.all([
    db()
      .select({
        id: tables.workflowSubtasks.id,
        sortOrder: tables.workflowSubtasks.sortOrder,
        title: tables.workflowSubtasks.title,
        description: tables.workflowSubtasks.description,
        route: tables.workflowSubtasks.route,
        status: tables.workflowSubtasks.status,
        suggestedPersonName: tables.people.displayName,
      })
      .from(tables.workflowSubtasks)
      .leftJoin(tables.people, eq(tables.people.id, tables.workflowSubtasks.suggestedPersonId))
      .where(eq(tables.workflowSubtasks.requestId, id))
      .orderBy(tables.workflowSubtasks.sortOrder),
    db()
      .select({
        id: tables.workflowActions.id,
        kind: tables.workflowActions.kind,
        title: tables.workflowActions.title,
        body: tables.workflowActions.body,
        destination: tables.workflowActions.destination,
        status: tables.workflowActions.status,
        citedEventIds: tables.workflowActions.citedEventIds,
        approvedAt: tables.workflowActions.approvedAt,
        executedAt: tables.workflowActions.executedAt,
        executionResult: tables.workflowActions.executionResult,
        expiresAt: tables.workflowActions.expiresAt,
        subtaskId: tables.workflowActions.subtaskId,
        approvedByName: tables.people.displayName,
      })
      .from(tables.workflowActions)
      .leftJoin(tables.people, eq(tables.people.id, tables.workflowActions.approvedById))
      .where(eq(tables.workflowActions.requestId, id))
      .orderBy(tables.workflowActions.createdAt),
  ]);

  const citedIds = (row.citedEventIds as string[]) ?? [];
  const citations: CitedEvent[] = citedIds.length
    ? await db()
        .select({
          id: tables.events.id,
          type: tables.events.type,
          title: tables.events.title,
          permalink: tables.events.permalink,
        })
        .from(tables.events)
        .where(inArray(tables.events.id, citedIds))
    : [];

  return presentSlackNames({
    ...row,
    citations,
    subtasks,
    actions: actions.map((a) => ({
      ...a,
      destination: (a.destination ?? {}) as Record<string, unknown>,
      executionResult: (a.executionResult ?? {}) as Record<string, unknown>,
    })),
  });
}

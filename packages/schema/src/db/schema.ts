import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Raw artifact registry — written by ingestion, referenced by everything downstream. */
export const rawArtifacts = pgTable("raw_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Source system: slack | gitlab | jira | gws | transcript */
  source: text("source").notNull(),
  /** Stable idempotency key within the source (slack ts, gitlab event id, drive file+revision). */
  sourceKey: text("source_key").notNull().unique(),
  /** S3/MinIO object key holding the immutable payload. */
  objectKey: text("object_key").notNull(),
  /** Preserved source metadata: permissions, timestamps, authorship, permalink. */
  sourceMeta: jsonb("source_meta").notNull().default({}),
  /** S3 key of the normalized rendition (e.g. standard transcript schema), when one exists. */
  normalizedObjectKey: text("normalized_object_key"),
  collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Slack channel registry: collection cursors plus the private-channel consent
 * record (ingestion-pipeline spec: Slack connector). A private channel is
 * collected only while the bot is a member — the owner inviting the bot IS the
 * opt-in; removing the bot revokes it.
 */
export const slackChannels = pgTable("slack_channels", {
  /** Slack channel ID (C…/G…). */
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  name: text("name").notNull(),
  isPrivate: boolean("is_private").notNull().default(false),
  archived: boolean("archived").notNull().default(false),
  /** Consent timestamp for private channels (first seen with bot membership). */
  optedInAt: timestamp("opted_in_at", { withTimezone: true }),
  /** When the org-visibility notice was posted into the private channel. */
  consentNoticePostedAt: timestamp("consent_notice_posted_at", { withTimezone: true }),
  /** Newest message ts already collected; next pull resumes after this. */
  lastPulledTs: text("last_pulled_ts"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Thread collection state. history() never re-surfaces a parent when replies
 * arrive, so recent threads are revisited each sync and re-captured as a new
 * artifact revision when they have grown.
 */
export const slackThreads = pgTable(
  "slack_threads",
  {
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    /** Newest message ts included in the last collected artifact revision. */
    latestCollectedTs: text("latest_collected_ts").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.threadTs] })],
);

/**
 * Slack profile names, including people who are not in the Google directory.
 * Ingestion and the web app use this so event text can say a name instead of
 * a raw user id. people.displayName wins when slackUserId is linked.
 */
export const slackUsers = pgTable("slack_users", {
  /** Slack user ID (U…/W…). */
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Artifacts filed for manual review after repeated agent failures
 * (brain-agents spec: retry with feedback, then park — never partial writes).
 */
export const parkedArtifacts = pgTable("parked_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  artifactId: uuid("artifact_id")
    .notNull()
    .unique()
    .references(() => rawArtifacts.id),
  stage: text("stage").notNull(),
  reason: text("reason").notNull(),
  attempts: integer("attempts").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const triageVerdictEnum = pgEnum("triage_verdict", ["signal", "noise"]);

/**
 * Every triage decision is recorded (ingestion-pipeline spec: Funnel
 * observability) so operators can sample decisions for precision/recall
 * audits and tune the threshold.
 */
export const triageDecisions = pgTable(
  "triage_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => rawArtifacts.id),
    sourceKey: text("source_key").notNull(),
    verdict: triageVerdictEnum("verdict").notNull(),
    /** P(signal) in [0,1] as estimated by the deciding method. */
    score: real("score").notNull(),
    /** Threshold in force when the decision was made. */
    threshold: real("threshold").notNull(),
    /** heuristic-noise | heuristic-signal | model | fallback-* */
    method: text("method").notNull(),
    /** Classifier hints: likely event types, topics. */
    tags: jsonb("tags").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("triage_decisions_created").on(t.createdAt),
    index("triage_decisions_verdict").on(t.verdict, t.createdAt),
  ],
);

// --- Entity registry (domain-model spec: Entity registry) ---

export const orgLevelEnum = pgEnum("org_level", ["L1", "L2"]);
export const projectStatusEnum = pgEnum("project_status", [
  "on-track",
  "at-risk",
  "blocked",
  "paused",
]);
export const priorityEnum = pgEnum("priority", ["P0", "P1", "P2", "P3"]);

/** Teams — seeded from first-level subgroups of gitlab.com/exampleorg. */
export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Path segment under exampleorg, e.g. "modcon". */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  gitlabGroupId: bigint("gitlab_group_id", { mode: "number" }).unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const people = pgTable("people", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  email: text("email").unique(),
  gitlabUsername: text("gitlab_username").unique(),
  slackUserId: text("slack_user_id").unique(),
  /** L1 leadership / L2 POC; null until assigned. L1 carries global reject rights. */
  orgLevel: orgLevelEnum("org_level"),
  teamId: uuid("team_id").references(() => teams.id),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Brain projects — seeded from second-level subgroups of exampleorg (e.g. "modcon/aprometheus"). */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Path relative to exampleorg, e.g. "modcon/aprometheus". */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  teamId: uuid("team_id").references(() => teams.id),
  pocId: uuid("poc_id").references(() => people.id),
  backupPocId: uuid("backup_poc_id").references(() => people.id),
  status: projectStatusEnum("status").notNull().default("on-track"),
  priority: priorityEnum("priority").notNull().default("P2"),
  gitlabGroupId: bigint("gitlab_group_id", { mode: "number" }).unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().defaultRandom(),
  gitlabProjectId: bigint("gitlab_project_id", { mode: "number" }).notNull().unique(),
  /** Full path, e.g. "rootgroup/team/project/repo". */
  path: text("path").notNull().unique(),
  name: text("name").notNull(),
  projectId: uuid("project_id").references(() => projects.id),
  /** Set when the repo sits directly under a team subgroup with no project between. */
  teamId: uuid("team_id").references(() => teams.id),
  defaultBranch: text("default_branch"),
  webUrl: text("web_url").notNull(),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- GitLab work item mirror (read-only; domain-model spec: GitLab work item mirror) ---

export const milestones = pgTable("milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  gitlabMilestoneId: bigint("gitlab_milestone_id", { mode: "number" }).notNull().unique(),
  projectId: uuid("project_id").references(() => projects.id),
  repoId: uuid("repo_id").references(() => repos.id),
  title: text("title").notNull(),
  description: text("description"),
  state: text("state").notNull().default("active"),
  startDate: date("start_date"),
  dueDate: date("due_date"),
  webUrl: text("web_url"),
  gitlabUpdatedAt: timestamp("gitlab_updated_at", { withTimezone: true }),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workItemKindEnum = pgEnum("work_item_kind", ["issue", "merge_request", "epic"]);
export const workItemSourceEnum = pgEnum("work_item_source", ["jira", "gitlab"]);

/** Tracker-agnostic mirror: Jira issues/epics (system of record) + GitLab issues/MRs. */
export const workItems = pgTable(
  "work_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: workItemSourceEnum("source").notNull(),
    kind: workItemKindEnum("kind").notNull(),
    /** Stable id within the source: Jira issue key (INFRA-12) or GitLab global id. */
    sourceId: text("source_id").notNull(),
    /** Human-facing reference: Jira key or GitLab !iid/#iid. */
    reference: text("reference"),
    /** Jira project key or GitLab project path, for placement and filtering. */
    sourceProject: text("source_project"),
    repoId: uuid("repo_id").references(() => repos.id),
    projectId: uuid("project_id").references(() => projects.id),
    title: text("title").notNull(),
    state: text("state").notNull(),
    webUrl: text("web_url").notNull(),
    authorUsername: text("author_username"),
    assignees: jsonb("assignees").notNull().default([]),
    labels: jsonb("labels").notNull().default([]),
    milestoneId: uuid("milestone_id").references(() => milestones.id),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("work_items_source_kind_source_id").on(t.source, t.kind, t.sourceId),
    index("work_items_repo_state").on(t.repoId, t.state),
    index("work_items_project_state").on(t.projectId, t.state),
  ],
);

/**
 * GitLab→Jira sync registry (design D5): one row per GitLab issue that has a
 * Jira counterpart. The primary loop/duplicate guard — webhook replays and
 * reconciliation both hit this before touching Jira.
 */
export const jiraSyncLinks = pgTable("jira_sync_links", {
  /** GitLab issue global id. */
  gitlabIssueId: bigint("gitlab_issue_id", { mode: "number" }).primaryKey(),
  gitlabProjectPath: text("gitlab_project_path").notNull(),
  gitlabIssueUrl: text("gitlab_issue_url").notNull(),
  jiraKey: text("jira_key").notNull().unique(),
  /** GitLab-side updated_at captured at last sync; newer means re-sync. */
  gitlabUpdatedAt: timestamp("gitlab_updated_at", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Generic per-connector cursor/state storage (gitlab + jira reconciliation). */
export const connectorState = pgTable("connector_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Project follows (task 5.9): the explicit opt-in that scopes a person's
 * daily digest beyond the projects they POC. Following is self-service from
 * the project page.
 */
export const projectFollows = pgTable(
  "project_follows",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.personId, t.projectId] }),
    index("project_follows_project").on(t.projectId),
  ],
);

export const syncRunStatusEnum = pgEnum("sync_run_status", ["ok", "failed"]);

/**
 * One row per connector sync run (connector-observability spec): the durable
 * audit trail behind the status page. Failures previously left no trace
 * outside logs; health and staleness are derived entirely from these rows.
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Matches raw_artifacts.source: slack | gitlab | jira | gws. */
    source: text("source").notNull(),
    status: syncRunStatusEnum("status").notNull(),
    /** The connector's own result shape (channels/threads, work items, …). */
    counts: jsonb("counts").notNull().default({}),
    /** Error message when status is failed. */
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [index("sync_runs_source_started").on(t.source, t.startedAt.desc())],
);

// --- Typed events with provenance (domain-model spec: Typed events with provenance) ---

export const eventTypeEnum = pgEnum("event_type", [
  "decision",
  "blocker_raised",
  "blocker_resolved",
  "status_change",
  "deadline_set",
  "deadline_slipped",
  "action_item",
  "milestone_update",
]);

/** rejected events leave current-state views but remain in history (reject-only model, D4). */
export const eventStatusEnum = pgEnum("event_status", ["active", "superseded", "rejected"]);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: eventTypeEnum("type").notNull(),
    status: eventStatusEnum("status").notNull().default("active"),
    /** The claim, one line. */
    title: text("title").notNull(),
    body: text("body"),
    details: jsonb("details").notNull().default({}),
    /** Extractor confidence in [0, 1]. */
    confidence: real("confidence").notNull(),
    /** When the thing happened in the source, when known. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
    /** Extracting agent/model identifier. */
    extractedBy: text("extracted_by"),
    /** Provenance: the raw artifact this event was extracted from. */
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => rawArtifacts.id),
    /** Span within the artifact (message ts range, transcript offsets, …). */
    span: jsonb("span"),
    /** Permalink to the original in the source system, when one exists. */
    permalink: text("permalink"),
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => events.id),
    /** Matched work item (action items; task 4.3 populates). */
    workItemId: uuid("work_item_id").references(() => workItems.id),
    /**
     * Idempotency key for deterministically-derived events (GitLab/Jira
     * LLM-bypass mapping): replaying the same source change upserts, never
     * duplicates. Null for LLM-extracted events.
     */
    dedupeKey: text("dedupe_key").unique(),
  },
  (t) => [
    index("events_status_type").on(t.status, t.type),
    index("events_extracted_at").on(t.extractedAt),
    index("events_artifact").on(t.artifactId),
  ],
);

/** Every event carries at least one project link; enforced by the ops layer. */
export const eventProjects = pgTable(
  "event_projects",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.projectId] }),
    index("event_projects_project").on(t.projectId),
  ],
);

// --- Versioned narratives (domain-model spec: Versioned narratives) ---

export const narrativeKindEnum = pgEnum("narrative_kind", [
  "status",
  "synthesis",
  "analysis",
  "report",
]);

export const narratives = pgTable(
  "narratives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    kind: narrativeKindEnum("kind").notNull().default("status"),
    title: text("title"),
    /** Head pointer; reverting a rejected revision moves it back. */
    currentRevisionId: uuid("current_revision_id").references(
      (): AnyPgColumn => narrativeRevisions.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("narratives_project").on(t.projectId, t.kind)],
);

export const narrativeRevisions = pgTable(
  "narrative_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    narrativeId: uuid("narrative_id")
      .notNull()
      .references(() => narratives.id),
    revision: integer("revision").notNull(),
    /** Markdown, LLM-written. */
    body: text("body").notNull(),
    summary: text("summary"),
    createdBy: text("created_by").notNull().default("synthesizer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("narrative_revisions_narrative_revision").on(t.narrativeId, t.revision)],
);

/** Provenance: the event IDs a narrative revision draws on (spec: revisions cite events). */
export const narrativeCitations = pgTable(
  "narrative_citations",
  {
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => narrativeRevisions.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
  },
  (t) => [
    primaryKey({ columns: [t.revisionId, t.eventId] }),
    index("narrative_citations_event").on(t.eventId),
  ],
);

// --- Contradiction records (domain-model spec: Contradiction records) ---

export const contradictionStatusEnum = pgEnum("contradiction_status", ["open", "resolved"]);

export const contradictions = pgTable(
  "contradictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id),
    /** The two conflicting claims; each event carries its own source citation. */
    eventAId: uuid("event_a_id")
      .notNull()
      .references(() => events.id),
    eventBId: uuid("event_b_id")
      .notNull()
      .references(() => events.id),
    summary: text("summary").notNull(),
    /** The brain's resolution, presented while the flag stays visible until a human resolves. */
    resolution: text("resolution"),
    status: contradictionStatusEnum("status").notNull().default("open"),
    resolvedById: uuid("resolved_by_id").references(() => people.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("contradictions_project_status").on(t.projectId, t.status)],
);

// --- Untracked work (domain-model spec: Untracked work records) ---

export const untrackedWorkStatusEnum = pgEnum("untracked_work_status", [
  "open",
  "issue_created",
  "dismissed",
]);

export const untrackedWork = pgTable(
  "untracked_work",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The action_item event that matched no mirrored work item. */
    eventId: uuid("event_id")
      .notNull()
      .unique()
      .references(() => events.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title").notNull(),
    status: untrackedWorkStatusEnum("status").notNull().default("open"),
    /** Set by explicit one-click issue creation. */
    workItemId: uuid("work_item_id").references(() => workItems.id),
    issueWebUrl: text("issue_web_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("untracked_work_project_status").on(t.projectId, t.status)],
);

// --- Lint findings (brain-agents spec: Drift-detecting linter) ---

export const lintFindingKindEnum = pgEnum("lint_finding_kind", [
  "narrative_drift",
  "sync_drift",
  "stale_event",
  "milestone_risk",
  "orphan",
  "unresolved_contradiction",
  "change_impact",
  "design_gap",
]);

export const lintFindingStatusEnum = pgEnum("lint_finding_status", [
  "open",
  "resolved",
  "dismissed",
]);

/**
 * Linter output: one row per detected inconsistency, deduped on dedupe_key so
 * scheduled re-runs refresh rather than duplicate. Deterministic findings
 * auto-resolve when the underlying condition clears on a later run.
 */
export const lintFindings = pgTable(
  "lint_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: lintFindingKindEnum("kind").notNull(),
    status: lintFindingStatusEnum("status").notNull().default("open"),
    projectId: uuid("project_id").references(() => projects.id),
    /** One-line claim of what's inconsistent. */
    summary: text("summary").notNull(),
    detail: text("detail"),
    /** Citations: eventIds, workItemIds, jiraKey, milestoneId, contradictionId, revisionId, … */
    refs: jsonb("refs").notNull().default({}),
    /** Stable identity of the condition (e.g. "sync_drift:INFRA-12"). */
    dedupeKey: text("dedupe_key").notNull().unique(),
    createdBy: text("created_by").notNull().default("linter"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Bumped on every run that still detects the condition. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("lint_findings_project_status").on(t.projectId, t.status),
    index("lint_findings_kind_status").on(t.kind, t.status),
  ],
);

// --- Cross-project dependencies (brain-agents spec: Dependency, conflict, gap, and change-impact analysis) ---

export const dependencyStatusEnum = pgEnum("dependency_status", [
  "open",
  "resolved",
  "dismissed",
]);

/**
 * Cross-project dependency records, detected by the analysis pass from events
 * that cite multiple projects. Visible on both projects; the change-impact
 * check files lint findings on the dependent side when the prerequisite
 * project shows trouble. Same dedupe/auto-resolve lifecycle as lint findings.
 */
export const dependencies = pgTable(
  "dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The project whose work is waiting. */
    dependentProjectId: uuid("dependent_project_id")
      .notNull()
      .references(() => projects.id),
    /** The project being waited on. */
    prerequisiteProjectId: uuid("prerequisite_project_id")
      .notNull()
      .references(() => projects.id),
    summary: text("summary").notNull(),
    /** Citations: eventIds backing the dependency claim. */
    refs: jsonb("refs").notNull().default({}),
    dedupeKey: text("dedupe_key").notNull().unique(),
    status: dependencyStatusEnum("status").notNull().default("open"),
    createdBy: text("created_by").notNull().default("linter"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("dependencies_dependent_status").on(t.dependentProjectId, t.status),
    index("dependencies_prerequisite_status").on(t.prerequisiteProjectId, t.status),
  ],
);

// --- LLM usage metering (brain-agents spec: Tiered Bedrock model routing) ---

export const agentEnum = pgEnum("agent", [
  "triage",
  "extractor",
  "synthesizer",
  "linter",
  "reporter",
  "query",
  "workflow",
]);

/**
 * One row per Bedrock invocation. Powers the app-enforced per-agent budget
 * caps (Bedrock has no per-key budgets) and the token-spend dashboards.
 */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agent: agentEnum("agent").notNull(),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    /** Estimated cost in microdollars (USD × 1e6) — integer math, no float drift. */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull(),
    /** What the call was for (job kind, artifact key, …) — attribution only. */
    purpose: text("purpose"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("llm_calls_agent_created").on(t.agent, t.createdAt)],
);

// --- Rejection model (domain-model spec: Rejection model) ---

export const rejectionTargetEnum = pgEnum("rejection_target", [
  "event",
  "narrative_revision",
  "priority_change",
]);

export const rejections = pgTable(
  "rejections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetKind: rejectionTargetEnum("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),
    projectId: uuid("project_id").references(() => projects.id),
    rejectedById: uuid("rejected_by_id")
      .notNull()
      .references(() => people.id),
    reason: text("reason").notNull(),
    /** Snapshot of the rejected content — correction data for the extraction agents (D4). */
    snapshot: jsonb("snapshot").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rejections_target").on(t.targetKind, t.targetId),
    index("rejections_project").on(t.projectId),
  ],
);

// --- Reports (brain-agents spec: Reporter; web-app spec: Report generation) ---

export const reportScopeEnum = pgEnum("report_scope", ["portfolio", "team"]);

export const reportStatusEnum = pgEnum("report_status", ["draft", "published"]);

/**
 * Reporter output: point-in-time status report snapshots (document body plus
 * a slide outline). Every generation creates a new immutable row in draft;
 * publishing is an explicit human action (D4 — no autonomous external
 * writes) that flips status and stamps who/when. Audience-scoped access
 * control layers on in 5.11; in v1 "published" marks the report as reviewed
 * and distributable.
 */
// --- Agent query (task 5.7; brain-agents spec: Query writes saved analyses) ---

export const queryStatusEnum = pgEnum("query_status", ["pending", "answered", "failed"]);

/**
 * Ask-the-brain questions and their async answers. A pending row means the
 * Query agent job is queued or running; answered rows carry the cited answer;
 * failed rows surface the error so the user can re-ask.
 */
export const brainQueries = pgTable(
  "brain_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    question: text("question").notNull(),
    askedById: uuid("asked_by_id")
      .notNull()
      .references(() => people.id),
    status: queryStatusEnum("status").notNull().default("pending"),
    /** Markdown with [event:<id>] citations; set when status = answered. */
    answer: text("answer"),
    citedEventIds: jsonb("cited_event_ids").notNull().default([]),
    answeredBy: text("answered_by"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [index("brain_queries_asker_created").on(t.askedById, t.createdAt)],
);

/**
 * Saved analyses: answered queries a human explicitly filed back into the
 * brain. First-class searchable documents (FTS index in migration).
 */
export const analyses = pgTable(
  "analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queryId: uuid("query_id")
      .notNull()
      .references(() => brainQueries.id),
    title: text("title").notNull(),
    /** Snapshot of the answer at save time. */
    body: text("body").notNull(),
    citedEventIds: jsonb("cited_event_ids").notNull().default([]),
    savedById: uuid("saved_by_id")
      .notNull()
      .references(() => people.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("analyses_created").on(t.createdAt)],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: reportScopeEnum("scope").notNull(),
    /** Set when scope = "team". */
    teamId: uuid("team_id").references(() => teams.id),
    title: text("title").notNull(),
    /** Markdown document, LLM-written, with [event:<id>] citations. */
    body: text("body").notNull(),
    /** Slide outline: [{ title, bullets: string[] }]. */
    slides: jsonb("slides").notNull().default([]),
    /** Every event id the report draws on (provenance). */
    citedEventIds: jsonb("cited_event_ids").notNull().default([]),
    status: reportStatusEnum("status").notNull().default("draft"),
    /** Null for scheduled runs; the requesting person for on-demand ones. */
    requestedById: uuid("requested_by_id").references(() => people.id),
    createdBy: text("created_by").notNull().default("reporter"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedById: uuid("published_by_id").references(() => people.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    index("reports_scope_created").on(t.scope, t.createdAt),
    index("reports_status_created").on(t.status, t.createdAt),
  ],
);

// --- Agent workflows (task 6.x; agent-workflows spec: drafts + approval + routing) ---

export const workflowRequestStatusEnum = pgEnum("workflow_request_status", [
  "pending",
  "drafted",
  "failed",
  "cancelled",
  "completed",
]);

export const workflowSubtaskStatusEnum = pgEnum("workflow_subtask_status", [
  "proposed",
  "approved",
  "in_progress",
  "done",
  "cancelled",
]);

export const workflowSubtaskRouteEnum = pgEnum("workflow_subtask_route", [
  "person",
  "agent_workflow",
  "none",
]);

export const workflowActionKindEnum = pgEnum("workflow_action_kind", [
  "jira_issue",
  "slack_message",
  "email",
  "document",
]);

export const workflowActionStatusEnum = pgEnum("workflow_action_status", [
  "draft",
  "approved",
  "executing",
  "executed",
  "failed",
  "expired",
  "cancelled",
]);

/**
 * Natural-language workflow request. Pending while the Workflow agent drafts;
 * drafted once sub-tasks + outbound action drafts exist; completed when every
 * approved action has finished executing (or the request is cancelled).
 */
export const workflowRequests = pgTable(
  "workflow_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    request: text("request").notNull(),
    requestedById: uuid("requested_by_id")
      .notNull()
      .references(() => people.id),
    status: workflowRequestStatusEnum("status").notNull().default("pending"),
    /** Agent summary of the plan (markdown with [event:<id>] citations). */
    summary: text("summary"),
    citedEventIds: jsonb("cited_event_ids").notNull().default([]),
    draftedBy: text("drafted_by"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    draftedAt: timestamp("drafted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("workflow_requests_asker_created").on(t.requestedById, t.createdAt)],
);

/**
 * Decomposition of a large request into trackable sub-tasks (agent-workflows
 * spec). Progress is visible against the parent request.
 */
export const workflowSubtasks = pgTable(
  "workflow_subtasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => workflowRequests.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    route: workflowSubtaskRouteEnum("route").notNull().default("none"),
    suggestedPersonId: uuid("suggested_person_id").references(() => people.id),
    status: workflowSubtaskStatusEnum("status").notNull().default("proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_subtasks_request").on(t.requestId, t.sortOrder)],
);

/**
 * Draft outbound actions. Never sent/filed until an authorized user approves;
 * the executor then performs the named action with brokered credentials.
 */
export const workflowActions = pgTable(
  "workflow_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => workflowRequests.id, { onDelete: "cascade" }),
    subtaskId: uuid("subtask_id").references(() => workflowSubtasks.id, {
      onDelete: "set null",
    }),
    kind: workflowActionKindEnum("kind").notNull(),
    /** Short preview headline shown in the approval UI. */
    title: text("title").notNull(),
    /** Full content preview (message body, issue description, document, …). */
    body: text("body").notNull(),
    /**
     * Destination preview: { jiraProjectKey?, assigneeEmail?, slackChannel?,
     * slackUserId?, emailTo?, emailSubject? }. Never contains secrets.
     */
    destination: jsonb("destination").notNull().default({}),
    citedEventIds: jsonb("cited_event_ids").notNull().default([]),
    status: workflowActionStatusEnum("status").notNull().default("draft"),
    approvedById: uuid("approved_by_id").references(() => people.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    /** Outcome recorded after execution (issue key, message ts, refuse reason, …). */
    executionResult: jsonb("execution_result").notNull().default({}),
    /** Drafts expire if never approved (agent-workflows spec). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workflow_actions_request").on(t.requestId, t.status),
    index("workflow_actions_expires").on(t.status, t.expiresAt),
  ],
);

/**
 * Executor audit log: every named-action attempt (allowed or refused). Agents
 * never see credentials; out-of-scope attempts are recorded for review.
 */
export const executorAudit = pgTable(
  "executor_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actionName: text("action_name").notNull(),
    actionId: uuid("action_id").references(() => workflowActions.id, {
      onDelete: "set null",
    }),
    allowed: boolean("allowed").notNull(),
    /** Human-readable result or refusal reason — never secrets. */
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("executor_audit_created").on(t.createdAt)],
);

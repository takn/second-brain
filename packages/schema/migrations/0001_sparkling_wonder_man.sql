CREATE TYPE "public"."contradiction_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('active', 'superseded', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('decision', 'blocker_raised', 'blocker_resolved', 'status_change', 'deadline_set', 'deadline_slipped', 'action_item', 'milestone_update');--> statement-breakpoint
CREATE TYPE "public"."narrative_kind" AS ENUM('status', 'synthesis', 'analysis', 'report');--> statement-breakpoint
CREATE TYPE "public"."org_level" AS ENUM('L1', 'L2');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('P0', 'P1', 'P2', 'P3');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('on-track', 'at-risk', 'blocked', 'paused');--> statement-breakpoint
CREATE TYPE "public"."rejection_target" AS ENUM('event', 'narrative_revision', 'priority_change');--> statement-breakpoint
CREATE TYPE "public"."untracked_work_status" AS ENUM('open', 'issue_created', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."work_item_kind" AS ENUM('issue', 'merge_request', 'epic');--> statement-breakpoint
CREATE TABLE "contradictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"event_a_id" uuid NOT NULL,
	"event_b_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"resolution" text,
	"status" "contradiction_status" DEFAULT 'open' NOT NULL,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_projects" (
	"event_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "event_projects_event_id_project_id_pk" PRIMARY KEY("event_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "event_type" NOT NULL,
	"status" "event_status" DEFAULT 'active' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real NOT NULL,
	"occurred_at" timestamp with time zone,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extracted_by" text,
	"artifact_id" uuid NOT NULL,
	"span" jsonb,
	"permalink" text,
	"superseded_by_id" uuid,
	"work_item_id" uuid
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gitlab_milestone_id" bigint NOT NULL,
	"project_id" uuid,
	"repo_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'active' NOT NULL,
	"start_date" date,
	"due_date" date,
	"web_url" text,
	"gitlab_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_gitlab_milestone_id_unique" UNIQUE("gitlab_milestone_id")
);
--> statement-breakpoint
CREATE TABLE "narrative_citations" (
	"revision_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	CONSTRAINT "narrative_citations_revision_id_event_id_pk" PRIMARY KEY("revision_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "narrative_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"narrative_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	"summary" text,
	"created_by" text DEFAULT 'synthesizer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "narratives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "narrative_kind" DEFAULT 'status' NOT NULL,
	"title" text,
	"current_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"gitlab_username" text,
	"slack_user_id" text,
	"org_level" "org_level",
	"team_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_email_unique" UNIQUE("email"),
	CONSTRAINT "people_gitlab_username_unique" UNIQUE("gitlab_username"),
	CONSTRAINT "people_slack_user_id_unique" UNIQUE("slack_user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"team_id" uuid,
	"poc_id" uuid,
	"backup_poc_id" uuid,
	"status" "project_status" DEFAULT 'on-track' NOT NULL,
	"priority" "priority" DEFAULT 'P2' NOT NULL,
	"gitlab_group_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_gitlab_group_id_unique" UNIQUE("gitlab_group_id")
);
--> statement-breakpoint
CREATE TABLE "rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_kind" "rejection_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"project_id" uuid,
	"rejected_by_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gitlab_project_id" bigint NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"project_id" uuid,
	"team_id" uuid,
	"default_branch" text,
	"web_url" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_gitlab_project_id_unique" UNIQUE("gitlab_project_id"),
	CONSTRAINT "repos_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"gitlab_group_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_slug_unique" UNIQUE("slug"),
	CONSTRAINT "teams_gitlab_group_id_unique" UNIQUE("gitlab_group_id")
);
--> statement-breakpoint
CREATE TABLE "untracked_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "untracked_work_status" DEFAULT 'open' NOT NULL,
	"work_item_id" uuid,
	"issue_web_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "untracked_work_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "work_item_kind" NOT NULL,
	"gitlab_id" bigint NOT NULL,
	"gitlab_iid" bigint,
	"repo_id" uuid,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"web_url" text NOT NULL,
	"author_username" text,
	"assignees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"milestone_id" uuid,
	"gitlab_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_event_a_id_events_id_fk" FOREIGN KEY ("event_a_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_event_b_id_events_id_fk" FOREIGN KEY ("event_b_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_resolved_by_id_people_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_projects" ADD CONSTRAINT "event_projects_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_projects" ADD CONSTRAINT "event_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_artifact_id_raw_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."raw_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_superseded_by_id_events_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrative_citations" ADD CONSTRAINT "narrative_citations_revision_id_narrative_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."narrative_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrative_citations" ADD CONSTRAINT "narrative_citations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrative_revisions" ADD CONSTRAINT "narrative_revisions_narrative_id_narratives_id_fk" FOREIGN KEY ("narrative_id") REFERENCES "public"."narratives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narratives" ADD CONSTRAINT "narratives_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narratives" ADD CONSTRAINT "narratives_current_revision_id_narrative_revisions_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."narrative_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_poc_id_people_id_fk" FOREIGN KEY ("poc_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_backup_poc_id_people_id_fk" FOREIGN KEY ("backup_poc_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejections" ADD CONSTRAINT "rejections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejections" ADD CONSTRAINT "rejections_rejected_by_id_people_id_fk" FOREIGN KEY ("rejected_by_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "untracked_work" ADD CONSTRAINT "untracked_work_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "untracked_work" ADD CONSTRAINT "untracked_work_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "untracked_work" ADD CONSTRAINT "untracked_work_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contradictions_project_status" ON "contradictions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "event_projects_project" ON "event_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "events_status_type" ON "events" USING btree ("status","type");--> statement-breakpoint
CREATE INDEX "events_extracted_at" ON "events" USING btree ("extracted_at");--> statement-breakpoint
CREATE INDEX "events_artifact" ON "events" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "narrative_citations_event" ON "narrative_citations" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "narrative_revisions_narrative_revision" ON "narrative_revisions" USING btree ("narrative_id","revision");--> statement-breakpoint
CREATE INDEX "narratives_project" ON "narratives" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "rejections_target" ON "rejections" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "rejections_project" ON "rejections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "untracked_work_project_status" ON "untracked_work" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_kind_gitlab_id" ON "work_items" USING btree ("kind","gitlab_id");--> statement-breakpoint
CREATE INDEX "work_items_repo_state" ON "work_items" USING btree ("repo_id","state");
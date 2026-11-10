CREATE TYPE "public"."work_item_source" AS ENUM('jira', 'gitlab');--> statement-breakpoint
CREATE TABLE "connector_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jira_sync_links" (
	"gitlab_issue_id" bigint PRIMARY KEY NOT NULL,
	"gitlab_project_path" text NOT NULL,
	"gitlab_issue_url" text NOT NULL,
	"jira_key" text NOT NULL,
	"gitlab_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jira_sync_links_jira_key_unique" UNIQUE("jira_key")
);
--> statement-breakpoint
DROP INDEX "work_items_kind_gitlab_id";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "source" "work_item_source" NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "source_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "source_project" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "source_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_source_kind_source_id" ON "work_items" USING btree ("source","kind","source_id");--> statement-breakpoint
CREATE INDEX "work_items_project_state" ON "work_items" USING btree ("project_id","state");--> statement-breakpoint
ALTER TABLE "work_items" DROP COLUMN "gitlab_id";--> statement-breakpoint
ALTER TABLE "work_items" DROP COLUMN "gitlab_iid";--> statement-breakpoint
ALTER TABLE "work_items" DROP COLUMN "gitlab_updated_at";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_dedupe_key_unique" UNIQUE("dedupe_key");
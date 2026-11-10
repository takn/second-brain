CREATE TYPE "public"."lint_finding_kind" AS ENUM('narrative_drift', 'sync_drift', 'stale_event', 'milestone_risk', 'orphan', 'unresolved_contradiction');--> statement-breakpoint
CREATE TYPE "public"."lint_finding_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TABLE "lint_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "lint_finding_kind" NOT NULL,
	"status" "lint_finding_status" DEFAULT 'open' NOT NULL,
	"project_id" uuid,
	"summary" text NOT NULL,
	"detail" text,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_by" text DEFAULT 'linter' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "lint_findings_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "lint_findings" ADD CONSTRAINT "lint_findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lint_findings_project_status" ON "lint_findings" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "lint_findings_kind_status" ON "lint_findings" USING btree ("kind","status");
CREATE TYPE "public"."dependency_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
ALTER TYPE "public"."lint_finding_kind" ADD VALUE 'change_impact';--> statement-breakpoint
ALTER TYPE "public"."lint_finding_kind" ADD VALUE 'design_gap';--> statement-breakpoint
CREATE TABLE "dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dependent_project_id" uuid NOT NULL,
	"prerequisite_project_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" "dependency_status" DEFAULT 'open' NOT NULL,
	"created_by" text DEFAULT 'linter' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "dependencies_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_dependent_project_id_projects_id_fk" FOREIGN KEY ("dependent_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_prerequisite_project_id_projects_id_fk" FOREIGN KEY ("prerequisite_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dependencies_dependent_status" ON "dependencies" USING btree ("dependent_project_id","status");--> statement-breakpoint
CREATE INDEX "dependencies_prerequisite_status" ON "dependencies" USING btree ("prerequisite_project_id","status");
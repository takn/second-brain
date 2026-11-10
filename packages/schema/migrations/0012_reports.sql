CREATE TYPE "public"."report_scope" AS ENUM('portfolio', 'team');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "report_scope" NOT NULL,
	"team_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"slides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cited_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "report_status" DEFAULT 'draft' NOT NULL,
	"requested_by_id" uuid,
	"created_by" text DEFAULT 'reporter' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by_id" uuid,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_requested_by_id_people_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_published_by_id_people_id_fk" FOREIGN KEY ("published_by_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reports_scope_created" ON "reports" USING btree ("scope","created_at");--> statement-breakpoint
CREATE INDEX "reports_status_created" ON "reports" USING btree ("status","created_at");
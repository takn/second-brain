CREATE TYPE "public"."query_status" AS ENUM('pending', 'answered', 'failed');--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"cited_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"saved_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question" text NOT NULL,
	"asked_by_id" uuid NOT NULL,
	"status" "query_status" DEFAULT 'pending' NOT NULL,
	"answer" text,
	"cited_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answered_by" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_query_id_brain_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."brain_queries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_saved_by_id_people_id_fk" FOREIGN KEY ("saved_by_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_queries" ADD CONSTRAINT "brain_queries_asked_by_id_people_id_fk" FOREIGN KEY ("asked_by_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_created" ON "analyses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "brain_queries_asker_created" ON "brain_queries" USING btree ("asked_by_id","created_at");--> statement-breakpoint
-- Saved analyses are first-class searchable documents (task 5.6 joins them into FTS).
CREATE INDEX IF NOT EXISTS "analyses_fts" ON "analyses" USING gin (
  to_tsvector('english', "title" || ' ' || "body")
);

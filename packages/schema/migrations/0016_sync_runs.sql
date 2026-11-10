CREATE TYPE "public"."sync_run_status" AS ENUM('ok', 'failed');--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"status" "sync_run_status" NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sync_runs_source_started" ON "sync_runs" USING btree ("source","started_at" DESC NULLS LAST);
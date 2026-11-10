CREATE TYPE "public"."triage_verdict" AS ENUM('signal', 'noise');--> statement-breakpoint
CREATE TABLE "triage_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"verdict" "triage_verdict" NOT NULL,
	"score" real NOT NULL,
	"threshold" real NOT NULL,
	"method" text NOT NULL,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "triage_decisions" ADD CONSTRAINT "triage_decisions_artifact_id_raw_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."raw_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "triage_decisions_created" ON "triage_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "triage_decisions_verdict" ON "triage_decisions" USING btree ("verdict","created_at");
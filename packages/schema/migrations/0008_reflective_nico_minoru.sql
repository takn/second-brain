CREATE TABLE "parked_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parked_artifacts_artifact_id_unique" UNIQUE("artifact_id")
);
--> statement-breakpoint
ALTER TABLE "parked_artifacts" ADD CONSTRAINT "parked_artifacts_artifact_id_raw_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."raw_artifacts"("id") ON DELETE no action ON UPDATE no action;
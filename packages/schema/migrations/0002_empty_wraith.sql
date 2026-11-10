CREATE TABLE "slack_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"opted_in_at" timestamp with time zone,
	"consent_notice_posted_at" timestamp with time zone,
	"last_pulled_ts" text,
	"last_synced_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);

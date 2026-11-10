CREATE TABLE "slack_users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "slack_threads" (
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"latest_collected_ts" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_threads_channel_id_thread_ts_pk" PRIMARY KEY("channel_id","thread_ts")
);

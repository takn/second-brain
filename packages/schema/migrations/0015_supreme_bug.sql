CREATE TYPE "public"."workflow_action_kind" AS ENUM('jira_issue', 'slack_message', 'email', 'document');--> statement-breakpoint
CREATE TYPE "public"."workflow_action_status" AS ENUM('draft', 'approved', 'executing', 'executed', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."workflow_request_status" AS ENUM('pending', 'drafted', 'failed', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."workflow_subtask_route" AS ENUM('person', 'agent_workflow', 'none');--> statement-breakpoint
CREATE TYPE "public"."workflow_subtask_status" AS ENUM('proposed', 'approved', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."agent" ADD VALUE 'workflow';--> statement-breakpoint
CREATE TABLE "executor_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_name" text NOT NULL,
	"action_id" uuid,
	"allowed" boolean NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"subtask_id" uuid,
	"kind" "workflow_action_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"destination" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cited_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "workflow_action_status" DEFAULT 'draft' NOT NULL,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"execution_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request" text NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"status" "workflow_request_status" DEFAULT 'pending' NOT NULL,
	"summary" text,
	"cited_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"drafted_by" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drafted_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_subtasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"route" "workflow_subtask_route" DEFAULT 'none' NOT NULL,
	"suggested_person_id" uuid,
	"status" "workflow_subtask_status" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "executor_audit" ADD CONSTRAINT "executor_audit_action_id_workflow_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."workflow_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_request_id_workflow_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."workflow_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_subtask_id_workflow_subtasks_id_fk" FOREIGN KEY ("subtask_id") REFERENCES "public"."workflow_subtasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_approved_by_id_people_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_requests" ADD CONSTRAINT "workflow_requests_requested_by_id_people_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_subtasks" ADD CONSTRAINT "workflow_subtasks_request_id_workflow_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."workflow_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_subtasks" ADD CONSTRAINT "workflow_subtasks_suggested_person_id_people_id_fk" FOREIGN KEY ("suggested_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "executor_audit_created" ON "executor_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "workflow_actions_request" ON "workflow_actions" USING btree ("request_id","status");--> statement-breakpoint
CREATE INDEX "workflow_actions_expires" ON "workflow_actions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "workflow_requests_asker_created" ON "workflow_requests" USING btree ("requested_by_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_subtasks_request" ON "workflow_subtasks" USING btree ("request_id","sort_order");
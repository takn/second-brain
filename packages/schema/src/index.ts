import { z } from "zod";

export * as tables from "./db/schema.ts";
export { createDb } from "./db/client.ts";
export { applyMigrations } from "./db/migrations.ts";

/** Typed event taxonomy — the atomic unit of the brain (see design.md D1). */
export const EVENT_TYPES = [
  "decision",
  "blocker_raised",
  "blocker_resolved",
  "status_change",
  "deadline_set",
  "deadline_slipped",
  "action_item",
  "milestone_update",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const SOURCES = ["slack", "gitlab", "jira", "gws", "transcript"] as const;
export type Source = (typeof SOURCES)[number];

export const PROJECT_STATUSES = ["on-track", "at-risk", "blocked", "paused"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ORG_LEVELS = ["L1", "L2"] as const;
export type OrgLevel = (typeof ORG_LEVELS)[number];

export const WORK_ITEM_KINDS = ["issue", "merge_request", "epic"] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

/** Agent roster (design D3 + D10 workflow); each is a budget-capped Bedrock caller. */
export const AGENTS = [
  "triage",
  "extractor",
  "synthesizer",
  "linter",
  "reporter",
  "query",
  "workflow",
] as const;
export type Agent = (typeof AGENTS)[number];

export * from "./ops/rejections.ts";
export * from "./ops/ownership.ts";
export {
  collectSlackIds,
  lookupSlackName,
  rewriteSlackIds,
  slackProfileName,
  type SlackProfile,
} from "./slack-ids.ts";

/** Job envelope carried on the SQS queue between funnel stages. */
export const jobSchema = z.object({
  kind: z.enum([
    "sync",
    "collect",
    "normalize",
    "triage",
    "extract",
    "synthesize",
    "lint",
    "report",
    "query",
    "digest",
    "workflow",
    "execute_workflow",
  ]),
  source: z.enum(SOURCES).optional(),
  /** raw_artifacts.source_key the job operates on, when applicable. */
  sourceKey: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  enqueuedAt: z.iso.datetime(),
});

export type Job = z.infer<typeof jobSchema>;

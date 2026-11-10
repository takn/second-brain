/**
 * Staged funnel skeleton (task 3.2): collect → normalize → triage → extract.
 *
 * Each stage does its work and enqueues the next; failures throw, leaving the
 * message for SQS redrive into the DLQ. Connector-specific collection (3.3+),
 * real triage models (3.4), and extraction (4.2) plug into these handlers.
 */
import { eq } from "drizzle-orm";
import { tables, type Job } from "@second-brain/schema";
import { createGitlabClient, itemFromEnvelope, mapGitlabItem, syncGitlab } from "./connectors/gitlab.ts";
import {
  createJiraClient,
  ensureJiraCounterpart,
  loadJiraConfig,
  mapJiraArtifact,
  syncJira,
} from "./connectors/jira.ts";
import { createGwsClient, getGwsConfig, mapGwsArtifact, syncGws } from "./connectors/gws.ts";
import { createSlackClient } from "./connectors/slack-client.ts";
import { syncSlack } from "./connectors/slack.ts";
import type { WorkerDeps } from "./lib/deps.ts";
import { getRawArtifact, putRawArtifact, type RawArtifactInput } from "./raw.ts";
import { runDigest } from "./digest.ts";
import { extractArtifact } from "./extractor.ts";
import { lintAll } from "./linter.ts";
import { answerQuery } from "./query.ts";
import { generateReport } from "./reporter.ts";
import { synthesizeProject } from "./synthesizer.ts";
import { triageArtifact } from "./triage.ts";
import { draftWorkflow, executeApprovedActions } from "./workflow.ts";
import { emitMetric } from "./lib/metrics.ts";

function jiraClientFromEnv() {
  const token = process.env.JIRA_API_TOKEN;
  const cloudId = process.env.JIRA_CLOUD_ID;
  if (!token || !cloudId) return null;
  return createJiraClient(token, cloudId);
}

function job(kind: Job["kind"], base: Pick<Job, "source" | "sourceKey">, payload = {}): Job {
  return { kind, ...base, payload, enqueuedAt: new Date().toISOString() };
}

function requireKeys(j: Job): { source: NonNullable<Job["source"]>; sourceKey: string } {
  if (!j.source || !j.sourceKey) {
    throw new Error(`${j.kind} job needs source and sourceKey`);
  }
  return { source: j.source, sourceKey: j.sourceKey };
}

/** Dispatch to the connector; returns its result counts for the sync_runs row. */
async function runSync(deps: WorkerDeps, source: string): Promise<Record<string, unknown>> {
  switch (source) {
    case "slack": {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) throw new Error("SLACK_BOT_TOKEN is not set; cannot sync slack");
      const teamIds = (process.env.SLACK_TEAM_IDS ?? "").split(",").filter(Boolean);
      if (teamIds.length === 0) throw new Error("SLACK_TEAM_IDS is not set; cannot sync slack");
      // empty/unset allowlist means all channels
      const allowlist = (process.env.SLACK_CHANNEL_ALLOWLIST ?? "").split(",").filter(Boolean);
      return await syncSlack(deps, createSlackClient(token), {
        teamIds,
        channelAllowlist: allowlist.length > 0 ? allowlist : undefined,
        backfillDays: Number(process.env.SLACK_BACKFILL_DAYS ?? 30),
      });
    }
    case "gitlab": {
      const token = process.env.GITLAB_TOKEN;
      if (!token) throw new Error("GITLAB_TOKEN is not set; cannot sync gitlab");
      return await syncGitlab(deps, createGitlabClient(token));
    }
    case "jira": {
      const client = jiraClientFromEnv();
      if (!client) throw new Error("JIRA_API_TOKEN / JIRA_CLOUD_ID not set; cannot sync jira");
      return await syncJira(deps, client, loadJiraConfig());
    }
    case "gws": {
      const config = await getGwsConfig();
      if (!config) throw new Error("gws secret unavailable; cannot sync google workspace");
      return await syncGws(deps, createGwsClient(config), config);
    }
    default:
      throw new Error(`no sync connector for source ${source}`);
  }
}

/**
 * Durable per-run record (connector-observability spec). Guarded: a broken
 * insert must never change the outcome of the sync it observes.
 * Exported for tests; production code goes through the sync handler.
 */
export async function recordSyncRun(
  deps: WorkerDeps,
  run: {
    source: string;
    status: "ok" | "failed";
    counts?: Record<string, unknown>;
    error?: string;
    startedAt: Date;
  },
): Promise<void> {
  try {
    await deps.db.insert(tables.syncRuns).values({
      source: run.source,
      status: run.status,
      counts: run.counts ?? {},
      error: run.error,
      startedAt: run.startedAt,
      durationMs: Date.now() - run.startedAt.getTime(),
    });
  } catch (err) {
    deps.logger.error({ err, source: run.source }, "failed to record sync run");
  }
}

/**
 * sync: run a connector's periodic pull. Enqueued by the in-worker scheduler
 * (or manually); the connector writes raw artifacts and feeds normalize.
 * Every executed run — including each redrive attempt — gets a sync_runs row.
 */
async function sync(deps: WorkerDeps, j: Job): Promise<void> {
  const source = j.source;
  if (source !== "slack" && source !== "gitlab" && source !== "jira" && source !== "gws") {
    deps.logger.warn({ source }, "no sync connector for source; acknowledging");
    return;
  }
  const startedAt = new Date();
  try {
    const result = await runSync(deps, source);
    const artifacts = typeof result.artifacts === "number" ? result.artifacts : 0;
    emitMetric("sync_artifacts", artifacts, { stage: "sync", source });
    emitMetric("sync_ok", 1, { stage: "sync", source });
    deps.logger.info(result, `${source} sync complete`);
    await recordSyncRun(deps, { source, status: "ok", counts: result, startedAt });
  } catch (err) {
    await recordSyncRun(deps, {
      source,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      startedAt,
    });
    throw err;
  }
}

/**
 * collect: store a raw artifact and hand it to normalize. Connectors either
 * call putRawArtifact directly or enqueue a collect job carrying the artifact
 * (webhooks and the watched folder do the latter).
 */
async function collect(deps: WorkerDeps, j: Job): Promise<void> {
  const { source, sourceKey } = requireKeys(j);
  const artifact = j.payload.artifact as Omit<RawArtifactInput, "source" | "sourceKey"> | undefined;
  if (!artifact) throw new Error("collect job payload.artifact is missing");
  const { created } = await putRawArtifact(deps, {
    source,
    sourceKey,
    payload: artifact.payload,
    sourceMeta: artifact.sourceMeta ?? {},
  });
  if (created) {
    await deps.enqueue([job("normalize", { source, sourceKey })]);
  } else {
    deps.logger.debug({ sourceKey }, "duplicate collect; artifact already registered");
  }
}

/**
 * normalize: unify formats and dedupe, then route by source. Slack artifacts
 * head to triage (LLM path); GitLab and Jira artifacts map deterministically
 * to work_items/events with no LLM (design D2 bypass), and GitLab issues feed
 * the GitLab→Jira sync.
 */
async function normalize(deps: WorkerDeps, j: Job): Promise<void> {
  const { source, sourceKey } = requireKeys(j);
  const [row] = await deps.db
    .select()
    .from(tables.rawArtifacts)
    .where(eq(tables.rawArtifacts.sourceKey, sourceKey));
  if (!row) throw new Error(`normalize: no raw artifact for ${sourceKey}`);
  const envelope = await getRawArtifact(deps, row.objectKey);

  switch (source) {
    case "gitlab": {
      const item = itemFromEnvelope(envelope);
      if (!item) {
        deps.logger.info({ sourceKey }, "gitlab artifact carries no work item; acknowledging");
        return;
      }
      await mapGitlabItem(deps, row.id, item);
      if (item.kind === "issue") {
        if (process.env.JIRA_SYNC_DISABLED === "true") {
          deps.logger.info({ sourceKey }, "gitlab→jira sync disabled by env; skipping");
          return;
        }
        const client = jiraClientFromEnv();
        if (client) {
          const result = await ensureJiraCounterpart(deps, client, loadJiraConfig(), item);
          deps.logger.info({ sourceKey, ...result }, "gitlab→jira sync");
        } else {
          deps.logger.warn({ sourceKey }, "jira credentials absent; skipping gitlab→jira sync");
        }
      }
      return;
    }
    case "jira":
      await mapJiraArtifact(deps, envelope);
      return;
    case "gws":
      await mapGwsArtifact(deps, { id: row.id, objectKey: row.objectKey }, envelope);
      return;
    default:
      await deps.enqueue([job("triage", { source, sourceKey })]);
  }
}

/**
 * triage: signal vs noise (task 3.4). Heuristics decide the obvious cases
 * free; ambiguous threads go to the cheap-model classifier. Noise stops here
 * — the raw artifact stays stored and the decision is recorded for sampling.
 */
async function triage(deps: WorkerDeps, j: Job): Promise<void> {
  const { source, sourceKey } = requireKeys(j);
  const [row] = await deps.db
    .select()
    .from(tables.rawArtifacts)
    .where(eq(tables.rawArtifacts.sourceKey, sourceKey));
  if (!row) throw new Error(`triage: no raw artifact for ${sourceKey}`);
  const envelope = await getRawArtifact(deps, row.objectKey);

  const decision = await triageArtifact(deps, row.id, sourceKey, envelope);
  deps.logger.info({ sourceKey, ...decision }, "triage decision");

  if (decision.verdict === "signal") {
    await deps.enqueue([
      job("extract", { source, sourceKey }, { triage: { score: decision.score, tags: decision.tags } }),
    ]);
  }
}

/** extract: the Extractor agent (task 4.2) — typed events, retry-then-park. */
async function extract(deps: WorkerDeps, j: Job): Promise<void> {
  const { sourceKey } = requireKeys(j);
  const [row] = await deps.db
    .select()
    .from(tables.rawArtifacts)
    .where(eq(tables.rawArtifacts.sourceKey, sourceKey));
  if (!row) throw new Error(`extract: no raw artifact for ${sourceKey}`);
  const envelope = await getRawArtifact(deps, row.objectKey);
  const result = await extractArtifact(deps, row, envelope);
  deps.logger.info({ sourceKey, ...result }, "extraction complete");
}

/** synthesize: the Synthesizer agent (task 4.4) — cited narrative regeneration. */
async function synthesize(deps: WorkerDeps, j: Job): Promise<void> {
  const projectId = j.payload.projectId as string | undefined;
  if (!projectId) throw new Error("synthesize job needs payload.projectId");
  const result = await synthesizeProject(deps, projectId);
  deps.logger.info({ projectId, ...result }, "synthesis complete");
}

/** lint: the Linter agent (task 4.5) — scheduled drift detection. */
async function lint(deps: WorkerDeps, _j: Job): Promise<void> {
  const result = await lintAll(deps);
  deps.logger.info(result, "lint pass complete");
}

/** report: the Reporter agent (task 4.8) — draft report snapshot generation. */
async function report(deps: WorkerDeps, j: Job): Promise<void> {
  const scope = j.payload.scope === "team" ? "team" : "portfolio";
  const result = await generateReport(deps, {
    scope,
    teamId: j.payload.teamId as string | undefined,
    requestedById: j.payload.requestedById as string | undefined,
  });
  deps.logger.info({ scope, ...result }, "report job complete");
}

/** query: the Query agent (task 5.7) — async ask-the-brain answering. */
async function query(deps: WorkerDeps, j: Job): Promise<void> {
  const queryId = j.payload.queryId as string | undefined;
  if (!queryId) throw new Error("query job needs payload.queryId");
  const result = await answerQuery(deps, queryId);
  deps.logger.info({ queryId, ...result }, "query job complete");
}

/** digest: daily Slack DM per owner/follower (task 5.9). */
async function digest(deps: WorkerDeps, _j: Job): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set; cannot send digests");
  const baseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  if (!baseUrl) throw new Error("APP_BASE_URL is not set; digest deep links need it");
  const allowlist = (process.env.DIGEST_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const result = await runDigest(deps, createSlackClient(token), {
    baseUrl,
    allowlist: allowlist.length > 0 ? allowlist : undefined,
    windowMs: Number(process.env.DIGEST_WINDOW_MS ?? 86_400_000),
  });
  deps.logger.info(result, "digest run complete");
}

/** workflow: Workflow agent drafts sub-tasks + outbound actions (task 6.1/6.3). */
async function workflow(deps: WorkerDeps, j: Job): Promise<void> {
  const requestId = j.payload.requestId as string | undefined;
  if (!requestId) throw new Error("workflow job needs payload.requestId");
  const result = await draftWorkflow(deps, requestId);
  deps.logger.info({ requestId, ...result }, "workflow job complete");
}

/** execute_workflow: run approved outbound actions through the executor (6.4/6.5). */
async function execute_workflow(deps: WorkerDeps, j: Job): Promise<void> {
  const actionIds = (j.payload.actionIds as string[] | undefined) ?? [];
  if (actionIds.length === 0) throw new Error("execute_workflow job needs payload.actionIds");
  const result = await executeApprovedActions(deps, actionIds);
  deps.logger.info({ ...result, count: actionIds.length }, "execute_workflow job complete");
}

export const handlers: Record<Job["kind"], (deps: WorkerDeps, j: Job) => Promise<void>> = {
  sync,
  collect,
  normalize,
  triage,
  extract,
  synthesize,
  lint,
  report,
  query,
  digest,
  workflow,
  execute_workflow,
};

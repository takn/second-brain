import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { createDb, jobSchema } from "@second-brain/schema";
import pino from "pino";
import { handlers } from "./funnel.ts";
import {
  createEnqueue,
  createS3Client,
  createSqsClient,
  resolveQueueUrl,
  type WorkerDeps,
} from "./lib/deps.ts";
import { BudgetExhaustedError, createLlm, loadLlmConfig, recordBudgetDeferral } from "./lib/llm.ts";
import { recordStageResult } from "./lib/metrics.ts";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
});

const sqs = createSqsClient();
const queueName = process.env.SQS_QUEUE_JOBS ?? "brain-jobs";
let running = true;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down after current poll");
    running = false;
  });
}

async function handleJob(deps: WorkerDeps, body: string): Promise<void> {
  const parsed = jobSchema.safeParse(JSON.parse(body));
  if (!parsed.success) {
    // Unparseable jobs are dropped to the DLQ via redrive; log loudly.
    logger.error({ issues: parsed.error.issues }, "job failed schema validation");
    throw new Error("invalid job envelope");
  }
  const job = parsed.data;
  logger.info({ kind: job.kind, source: job.source, sourceKey: job.sourceKey }, "job received");

  try {
    await handlers[job.kind](deps, job);
    recordStageResult({
      stage: job.kind,
      source: job.source,
      ok: true,
      enqueuedAt: job.enqueuedAt,
    });
  } catch (err) {
    // Budget deferrals are not failures; they emit their own metric.
    if (!(err instanceof BudgetExhaustedError)) {
      recordStageResult({
        stage: job.kind,
        source: job.source,
        ok: false,
        enqueuedAt: job.enqueuedAt,
      });
    }
    throw err;
  }
}

async function main() {
  const queueUrl = await resolveQueueUrl(sqs, queueName);
  const { db } = createDb();
  const deps: WorkerDeps = {
    db,
    s3: createS3Client(),
    bucket: process.env.S3_BUCKET_RAW ?? "second-brain-raw",
    enqueue: createEnqueue(sqs, queueUrl),
    logger,
  };

  try {
    const llmConfig = loadLlmConfig();
    deps.llm = createLlm({ db, logger, config: llmConfig });
    logger.info(
      {
        models: Object.fromEntries(
          Object.entries(llmConfig.agents).map(([agent, a]) => [
            agent,
            llmConfig.tiers[a.tier].modelId,
          ]),
        ),
      },
      "bedrock llm configured",
    );
  } catch (err) {
    logger.warn({ err }, "llm disabled (config/llm.json missing or invalid)");
  }

  logger.info({ queueUrl }, "worker started, polling");

  // Connector scheduler: sync on boot and on an interval per source.
  // Safe with overlaps (artifacts + mappings are idempotent); one worker in v1.
  const { getGwsConfig } = await import("./connectors/gws.ts");
  const schedules: {
    source: "slack" | "gitlab" | "jira" | "gws";
    enabled: boolean;
    intervalMs: number;
  }[] = [
      {
        source: "slack",
        enabled: Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_TEAM_IDS),
        intervalMs: Number(process.env.SLACK_SYNC_INTERVAL_MS ?? 3_600_000),
      },
      {
        source: "gitlab",
        enabled: Boolean(process.env.GITLAB_TOKEN),
        intervalMs: Number(process.env.GITLAB_SYNC_INTERVAL_MS ?? 3_600_000),
      },
      {
        source: "jira",
        enabled: Boolean(process.env.JIRA_API_TOKEN && process.env.JIRA_CLOUD_ID),
        intervalMs: Number(process.env.JIRA_SYNC_INTERVAL_MS ?? 3_600_000),
      },
      {
        source: "gws",
        enabled: Boolean(await getGwsConfig().catch(() => null)),
        intervalMs: Number(process.env.GWS_SYNC_INTERVAL_MS ?? 3_600_000),
      },
    ];
  for (const s of schedules) {
    if (!s.enabled) {
      logger.info({ source: s.source }, "sync disabled (credentials not configured)");
      continue;
    }
    const enqueueSync = () => {
      Promise.resolve(
        deps.enqueue([
          { kind: "sync", source: s.source, payload: {}, enqueuedAt: new Date().toISOString() },
        ]),
      ).catch((err) => logger.error({ err, source: s.source }, "failed to enqueue sync"));
    };
    enqueueSync();
    setInterval(enqueueSync, s.intervalMs).unref();
  }

  // Linter (design D3): daily drift-detection pass. Runs on boot too — the
  // pass is idempotent (findings dedupe on stable keys) and budget-capped.
  const lintIntervalMs = Number(process.env.LINT_INTERVAL_MS ?? 86_400_000);
  const enqueueLint = () => {
    Promise.resolve(
      deps.enqueue([{ kind: "lint", payload: {}, enqueuedAt: new Date().toISOString() }]),
    ).catch((err) => logger.error({ err }, "failed to enqueue lint"));
  };
  enqueueLint();
  setInterval(enqueueLint, lintIntervalMs).unref();

  // Reporter (task 4.8): scheduled portfolio report, weekly by default.
  // Generation is NOT idempotent (each run writes a new draft), so instead of
  // enqueue-on-boot the scheduler checks the newest report's age — deploys
  // don't spam drafts and missed windows catch up on the next check.
  const { portfolioReportDue } = await import("./reporter.ts");
  const reportEveryMs = Number(process.env.REPORT_EVERY_MS ?? 7 * 86_400_000);
  const reportCheckMs = Number(process.env.REPORT_CHECK_INTERVAL_MS ?? 6 * 3_600_000);
  const maybeEnqueueReport = () => {
    portfolioReportDue(deps, reportEveryMs)
      .then((due) => {
        if (!due) return;
        return Promise.resolve(
          deps.enqueue([
            { kind: "report", payload: { scope: "portfolio" }, enqueuedAt: new Date().toISOString() },
          ]),
        );
      })
      .catch((err) => logger.error({ err }, "failed to schedule report"));
  };
  maybeEnqueueReport();
  setInterval(maybeEnqueueReport, reportCheckMs).unref();

  // Daily digest (task 5.9): DMs are external writes people actually see, so
  // the scheduler is opt-in (DIGEST_ENABLED) and claims exactly one run per
  // UTC day after the send hour; the job itself dedupes per person.
  if (process.env.DIGEST_ENABLED === "true" && process.env.SLACK_BOT_TOKEN) {
    const { claimDigestRun } = await import("./digest.ts");
    const digestHourUtc = Number(process.env.DIGEST_HOUR_UTC ?? 13);
    const maybeEnqueueDigest = () => {
      claimDigestRun(deps, digestHourUtc)
        .then((claimed) => {
          if (!claimed) return;
          return Promise.resolve(
            deps.enqueue([{ kind: "digest", payload: {}, enqueuedAt: new Date().toISOString() }]),
          );
        })
        .catch((err) => logger.error({ err }, "failed to schedule digest"));
    };
    maybeEnqueueDigest();
    setInterval(maybeEnqueueDigest, Number(process.env.DIGEST_CHECK_INTERVAL_MS ?? 900_000)).unref();
  } else {
    logger.info("digest disabled (set DIGEST_ENABLED=true with a slack token to enable)");
  }

  // Query hygiene (task 5.7): queries whose jobs died (DLQ, crash) would show
  // "thinking…" forever — sweep them to failed so the asker can re-ask.
  const { failStalePendingQueries } = await import("./query.ts");
  const queryStaleMs = Number(process.env.QUERY_PENDING_TIMEOUT_MS ?? 15 * 60_000);
  const sweepQueries = () => {
    failStalePendingQueries(deps, queryStaleMs).catch((err) =>
      logger.error({ err }, "stale query sweep failed"),
    );
  };
  sweepQueries();
  setInterval(sweepQueries, Math.max(queryStaleMs / 3, 60_000)).unref();

  // Workflow hygiene (task 6.x): stale pending drafts + expired unapproved actions.
  const {
    failStalePendingWorkflows,
    expireStaleDrafts,
  } = await import("./workflow.ts");
  const workflowStaleMs = Number(process.env.WORKFLOW_PENDING_TIMEOUT_MS ?? 15 * 60_000);
  const sweepWorkflows = () => {
    failStalePendingWorkflows(deps, workflowStaleMs).catch((err) =>
      logger.error({ err }, "stale workflow sweep failed"),
    );
    expireStaleDrafts(deps).catch((err) =>
      logger.error({ err }, "workflow draft expiry failed"),
    );
  };
  sweepWorkflows();
  setInterval(sweepWorkflows, Math.max(workflowStaleMs / 3, 60_000)).unref();

  while (running) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
      }),
    );

    for (const message of Messages ?? []) {
      try {
        await handleJob(deps, message.Body ?? "{}");
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          // Budget exhaustion queues the job rather than failing it (brain-agents
          // spec): re-enqueue a delayed copy and delete the original so retries
          // never count toward the DLQ redrive.
          const delaySeconds = Math.min(
            Number(process.env.LLM_BUDGET_RETRY_DELAY_S ?? 900),
            900, // SQS maximum
          );
          await deps.enqueue([jobSchema.parse(JSON.parse(message.Body ?? "{}"))], {
            delaySeconds,
          });
          await sqs.send(
            new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
          );
          recordBudgetDeferral(err.agent);
          logger.warn(
            { agent: err.agent, spentUsd: err.spentUsd, capUsd: err.capUsd, delaySeconds },
            "budget exhausted; job re-queued with delay",
          );
          continue;
        }
        // Leave the message for redrive; it lands in the DLQ after maxReceiveCount.
        logger.error({ err, messageId: message.MessageId }, "job failed; leaving for redrive");
      }
    }
  }

  logger.info("worker stopped");
}

main().catch((err) => {
  logger.fatal({ err }, "worker crashed");
  process.exit(1);
});

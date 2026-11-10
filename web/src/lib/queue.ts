/**
 * Web → worker job enqueue: rejections queue re-synthesis for affected
 * projects (design D4 — the correction pipeline runs through the same funnel).
 */
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Job, ResynthesisRequest } from "@second-brain/schema";

let client: SQSClient | null = null;
let queueUrlPromise: Promise<string> | null = null;

function sqs(): SQSClient {
  client ??= new SQSClient({
    endpoint: process.env.SQS_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
  });
  return client;
}

async function queueUrl(): Promise<string> {
  queueUrlPromise ??= (async () => {
    const name = process.env.SQS_QUEUE_JOBS;
    if (!name) throw new Error("SQS_QUEUE_JOBS not configured");
    const { QueueUrl } = await sqs().send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`queue not found: ${name}`);
    return QueueUrl;
  })();
  return queueUrlPromise;
}

/** Ask-the-brain (task 5.7): the worker's Query agent picks this up. */
export async function enqueueQuery(queryId: string): Promise<void> {
  const job: Job = {
    kind: "query",
    payload: { queryId },
    enqueuedAt: new Date().toISOString(),
  };
  const url = await queueUrl();
  await sqs().send(
    new SendMessageBatchCommand({
      QueueUrl: url,
      Entries: [{ Id: "0", MessageBody: JSON.stringify(job) }],
    }),
  );
}

/** Workflow agent (task 6.1): draft outbound actions from a natural-language request. */
export async function enqueueWorkflow(requestId: string): Promise<void> {
  const job: Job = {
    kind: "workflow",
    payload: { requestId },
    enqueuedAt: new Date().toISOString(),
  };
  const url = await queueUrl();
  await sqs().send(
    new SendMessageBatchCommand({
      QueueUrl: url,
      Entries: [{ Id: "0", MessageBody: JSON.stringify(job) }],
    }),
  );
}

/** Execute approved workflow actions through the worker executor (task 6.4/6.5). */
export async function enqueueExecuteWorkflow(actionIds: string[]): Promise<void> {
  if (actionIds.length === 0) return;
  const job: Job = {
    kind: "execute_workflow",
    payload: { actionIds },
    enqueuedAt: new Date().toISOString(),
  };
  const url = await queueUrl();
  await sqs().send(
    new SendMessageBatchCommand({
      QueueUrl: url,
      Entries: [{ Id: "0", MessageBody: JSON.stringify(job) }],
    }),
  );
}

/** On-demand report generation (task 4.8): the worker's Reporter picks this up. */
export async function enqueueReport(request: {
  scope: "portfolio" | "team";
  teamId?: string;
  requestedById: string;
}): Promise<void> {
  const job: Job = {
    kind: "report",
    payload: request,
    enqueuedAt: new Date().toISOString(),
  };
  const url = await queueUrl();
  await sqs().send(
    new SendMessageBatchCommand({
      QueueUrl: url,
      Entries: [{ Id: "0", MessageBody: JSON.stringify(job) }],
    }),
  );
}

export async function enqueueResynthesis(requests: ResynthesisRequest[]): Promise<void> {
  if (requests.length === 0) return;
  const jobs: Job[] = requests.map((r) => ({
    kind: "synthesize",
    payload: { projectId: r.projectId },
    enqueuedAt: new Date().toISOString(),
  }));
  const url = await queueUrl();
  for (let i = 0; i < jobs.length; i += 10) {
    await sqs().send(
      new SendMessageBatchCommand({
        QueueUrl: url,
        Entries: jobs.slice(i, i + 10).map((job, n) => ({
          Id: String(n),
          MessageBody: JSON.stringify(job),
          // Same debounce the synthesizer expects from funnel-driven jobs.
          DelaySeconds: 60,
        })),
      }),
    );
  }
}

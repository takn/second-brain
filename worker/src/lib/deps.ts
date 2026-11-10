import { S3Client } from "@aws-sdk/client-s3";
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createDb, type Job } from "@second-brain/schema";
import type { Logger } from "pino";
import type { Llm } from "./llm.ts";

/** Everything the funnel stages need, injected so tests can point at the local stack. */
export interface WorkerDeps {
  db: ReturnType<typeof createDb>["db"];
  s3: S3Client;
  bucket: string;
  enqueue: (jobs: Job[], opts?: { delaySeconds?: number }) => Promise<void> | void;
  logger: Logger;
  /** Bedrock caller; absent when config/llm.json is missing (LLM stages then fail loudly). */
  llm?: Llm;
}

export function createS3Client(env = process.env): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION ?? "us-east-1",
    forcePathStyle: Boolean(env.S3_ENDPOINT),
  });
}

export function createSqsClient(env = process.env): SQSClient {
  return new SQSClient({
    endpoint: env.SQS_ENDPOINT,
    region: env.S3_REGION ?? "us-east-1",
  });
}

/** SQS enqueue in batches of 10 (the SQS maximum). */
export function createEnqueue(
  sqs: SQSClient,
  queueUrl: string,
): (jobs: Job[], opts?: { delaySeconds?: number }) => Promise<void> {
  return async (jobs, opts) => {
    for (let i = 0; i < jobs.length; i += 10) {
      const batch = jobs.slice(i, i + 10);
      const { Failed } = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((job, n) => ({
            Id: String(n),
            MessageBody: JSON.stringify(job),
            DelaySeconds: opts?.delaySeconds,
          })),
        }),
      );
      if (Failed && Failed.length > 0) {
        throw new Error(`enqueue failed for ${Failed.length} job(s): ${Failed[0]?.Message}`);
      }
    }
  };
}

export async function resolveQueueUrl(sqs: SQSClient, queueName: string): Promise<string> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (!QueueUrl) throw new Error(`queue not found: ${queueName}`);
  return QueueUrl;
}

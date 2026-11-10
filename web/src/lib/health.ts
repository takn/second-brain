import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import postgres from "postgres";

export type CheckStatus = "ok" | "error";

export interface HealthReport {
  db: CheckStatus;
  storage: CheckStatus;
  queue: CheckStatus;
  checkedAt: string;
}

async function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return await Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function checkDb(): Promise<CheckStatus> {
  const url = process.env.DATABASE_URL;
  if (!url) return "error";
  const sql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await withTimeout(sql`select 1`);
    return "ok";
  } catch {
    return "error";
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

async function checkStorage(): Promise<CheckStatus> {
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
  });
  try {
    await withTimeout(s3.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET_RAW ?? "" })));
    return "ok";
  } catch {
    return "error";
  }
}

async function checkQueue(): Promise<CheckStatus> {
  const sqs = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
  });
  try {
    await withTimeout(
      sqs.send(new GetQueueUrlCommand({ QueueName: process.env.SQS_QUEUE_JOBS ?? "brain-jobs" })),
    );
    return "ok";
  } catch {
    return "error";
  }
}

export async function getHealth(): Promise<HealthReport> {
  const [db, storage, queue] = await Promise.all([checkDb(), checkStorage(), checkQueue()]);
  return { db, storage, queue, checkedAt: new Date().toISOString() };
}

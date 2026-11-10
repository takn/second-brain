import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

/**
 * GitLab group webhook receiver (task 3.5). Thin by design: verify the shared
 * secret, wrap the payload in a collect job, and hand it to the funnel — the
 * worker owns raw storage and mapping. Duplicate deliveries are absorbed by
 * the raw layer's idempotent sourceKeys.
 */

const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT,
  region: process.env.S3_REGION ?? "us-east-1",
});
let queueUrlPromise: Promise<string | undefined> | null = null;

function webhookSecret(): string | null {
  // App Runner injects the whole second-brain/gitlab secret JSON.
  const raw = process.env.GITLAB_CONNECTOR_SECRET;
  if (!raw) return process.env.GITLAB_WEBHOOK_SECRET ?? null;
  try {
    return (JSON.parse(raw) as { webhook_secret?: string }).webhook_secret ?? null;
  } catch {
    return null;
  }
}

/** Match the reconciliation poll's sourceKey format so both paths dedupe. */
function sourceKeyFor(body: Record<string, unknown>): string {
  const kind = body.object_kind as string;
  const attrs = (body.object_attributes ?? {}) as Record<string, unknown>;
  if (kind === "issue" || kind === "merge_request") {
    // Same normalization as the worker's reconciliation keys, so both dedupe.
    const updated = String(attrs.updated_at ?? new Date().toISOString())
      .replace(" UTC", "Z")
      .replace(" ", "T");
    return `gitlab:${kind}:${attrs.id}:${updated}`;
  }
  const project = (body.project ?? {}) as Record<string, unknown>;
  const id = attrs.id ?? (body.checkout_sha as string) ?? Date.now();
  return `gitlab:webhook:${kind}:${project.id ?? "unknown"}:${id}`;
}

export async function POST(request: Request): Promise<Response> {
  const secret = webhookSecret();
  if (!secret || request.headers.get("x-gitlab-token") !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  const sourceKey = sourceKeyFor(body);
  queueUrlPromise ??= sqs
    .send(new GetQueueUrlCommand({ QueueName: process.env.SQS_QUEUE_JOBS ?? "brain-jobs" }))
    .then((r) => r.QueueUrl);
  const queueUrl = await queueUrlPromise;
  if (!queueUrl) return Response.json({ error: "queue unavailable" }, { status: 503 });

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        kind: "collect",
        source: "gitlab",
        sourceKey,
        payload: {
          artifact: {
            payload: body,
            sourceMeta: {
              permalink: ((body.object_attributes ?? {}) as Record<string, unknown>).url,
              author: ((body.user ?? {}) as Record<string, unknown>).username,
              permissions: {
                projectPath: ((body.project ?? {}) as Record<string, unknown>)
                  .path_with_namespace,
              },
              timestamps: { receivedAt: new Date().toISOString() },
            },
          },
        },
        enqueuedAt: new Date().toISOString(),
      }),
    }),
  );

  return Response.json({ ok: true });
}

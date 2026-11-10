/**
 * Scoped outbound executor (task 6.5 / agent-workflows spec).
 *
 * Agents never hold credentials. Callers ask for a named action; this module
 * loads brokered secrets from the environment (injected from Secrets Manager
 * at deploy time) and performs only the allowlisted actions. Out-of-scope
 * names are refused and written to executor_audit for review. Prompts, model
 * contexts, and logs must never receive secret material — this module never
 * returns tokens or dumps env.
 */
import { tables } from "@second-brain/schema";
import type { WorkerDeps } from "./lib/deps.ts";
import { createJiraClient, type JiraCall } from "./connectors/jira.ts";
import { createSlackClient, type SlackCall } from "./connectors/slack-client.ts";
import { emitMetric } from "./lib/metrics.ts";

/** Named actions the executor will perform. Anything else is refused. */
export const EXECUTOR_SCOPE = [
  "jira.create_issue",
  "slack.post_message",
  "email.send",
  "document.approve",
] as const;

export type ExecutorActionName = (typeof EXECUTOR_SCOPE)[number];

export type Destination = {
  jiraProjectKey?: string;
  assigneeAccountId?: string;
  assigneeEmail?: string;
  slackChannel?: string;
  slackUserId?: string;
  emailTo?: string[];
  emailSubject?: string;
};

export type ExecuteInput = {
  actionName: string;
  actionId?: string;
  title: string;
  body: string;
  destination: Destination;
};

export type ExecuteResult = {
  allowed: boolean;
  ok: boolean;
  detail: string;
  result: Record<string, unknown>;
};

export type ExecutorClients = {
  jira?: JiraCall;
  slack?: SlackCall;
  /** Optional email sender; when absent, email.send is refused (no SES yet). */
  email?: (input: {
    to: string[];
    subject: string;
    body: string;
  }) => Promise<{ messageId: string }>;
  /** When true, jira/slack/email record intent without calling external APIs. */
  dryRun?: boolean;
};

function isScoped(name: string): name is ExecutorActionName {
  return (EXECUTOR_SCOPE as readonly string[]).includes(name);
}

async function audit(
  deps: WorkerDeps,
  input: {
    actionName: string;
    actionId?: string;
    allowed: boolean;
    detail: string;
  },
): Promise<void> {
  await deps.db.insert(tables.executorAudit).values({
    actionName: input.actionName,
    actionId: input.actionId,
    allowed: input.allowed,
    detail: input.detail.slice(0, 2000),
  });
}

export function clientsFromEnv(): ExecutorClients {
  const clients: ExecutorClients = {
    dryRun: process.env.EXECUTOR_DRY_RUN === "true",
  };
  const jiraToken = process.env.JIRA_API_TOKEN;
  const cloudId = process.env.JIRA_CLOUD_ID;
  if (jiraToken && cloudId) {
    clients.jira = createJiraClient(jiraToken, cloudId);
  }
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (slackToken) {
    clients.slack = createSlackClient(slackToken);
  }
  const emailFrom = process.env.EMAIL_FROM?.trim();
  if (emailFrom) {
    clients.email = createSesEmailSender(emailFrom);
  }
  return clients;
}

/** IAM-brokered SES sender — From comes from Secrets Manager; no SMTP password. */
export function createSesEmailSender(
  from: string,
  sendImpl?: (input: {
    to: string[];
    subject: string;
    body: string;
  }) => Promise<{ messageId: string }>,
): NonNullable<ExecutorClients["email"]> {
  if (sendImpl) return sendImpl;
  return async ({ to, subject, body }) => {
    const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
    const client = new SESv2Client({ region: process.env.S3_REGION ?? "us-east-1" });
    const res = await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: to },
        Content: {
          Simple: {
            Subject: { Data: subject.slice(0, 998), Charset: "UTF-8" },
            Body: { Text: { Data: body.slice(0, 100_000), Charset: "UTF-8" } },
          },
        },
      }),
    );
    return { messageId: res.MessageId ?? "" };
  };
}

/**
 * Perform one named outbound action. Never throws for policy refusals — those
 * return { allowed: false }. Transport failures set ok: false with a detail.
 */
export async function executeNamedAction(
  deps: WorkerDeps,
  clients: ExecutorClients,
  input: ExecuteInput,
): Promise<ExecuteResult> {
  if (!isScoped(input.actionName)) {
    const detail = `action outside executor scope: ${input.actionName}`;
    await audit(deps, {
      actionName: input.actionName,
      actionId: input.actionId,
      allowed: false,
      detail,
    });
    emitMetric("executor_refused", 1, { stage: "executor" });
    deps.logger.warn(
      { actionName: input.actionName, actionId: input.actionId },
      "executor refused out-of-scope action",
    );
    return { allowed: false, ok: false, detail, result: { refused: true } };
  }

  try {
    const result = await dispatch(clients, input);
    await audit(deps, {
      actionName: input.actionName,
      actionId: input.actionId,
      allowed: true,
      detail: result.detail,
    });
    emitMetric(result.ok ? "executor_ok" : "executor_failed", 1, { stage: "executor" });
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Never log credentials — error messages from our clients omit tokens.
    await audit(deps, {
      actionName: input.actionName,
      actionId: input.actionId,
      allowed: true,
      detail: `error: ${detail}`.slice(0, 2000),
    });
    emitMetric("executor_failed", 1, { stage: "executor" });
    deps.logger.error(
      { actionName: input.actionName, actionId: input.actionId, err: detail },
      "executor action failed",
    );
    return { allowed: true, ok: false, detail, result: { error: detail } };
  }
}

async function dispatch(clients: ExecutorClients, input: ExecuteInput): Promise<ExecuteResult> {
  const dest = input.destination;
  switch (input.actionName as ExecutorActionName) {
    case "jira.create_issue": {
      const projectKey = dest.jiraProjectKey?.trim();
      if (!projectKey) {
        return {
          allowed: true,
          ok: false,
          detail: "jira.create_issue requires destination.jiraProjectKey",
          result: {},
        };
      }
      if (clients.dryRun || !clients.jira) {
        if (!clients.jira && !clients.dryRun) {
          return {
            allowed: true,
            ok: false,
            detail: "jira credentials not configured",
            result: {},
          };
        }
        return {
          allowed: true,
          ok: true,
          detail: `dry-run jira issue in ${projectKey}: ${input.title}`,
          result: { dryRun: true, projectKey, summary: input.title },
        };
      }
      const data = await clients.jira("POST", "/issue", {
        fields: {
          project: { key: projectKey },
          issuetype: { name: "Task" },
          summary: input.title.slice(0, 255),
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: input.body.slice(0, 30_000) }],
              },
            ],
          },
        },
      });
      const key = String(data.key ?? "");
      const baseUrl = process.env.JIRA_BASE_URL ?? "https://example.atlassian.net";
      return {
        allowed: true,
        ok: Boolean(key),
        detail: key ? `created ${key}` : "jira create returned no key",
        result: { key, webUrl: key ? `${baseUrl}/browse/${key}` : undefined },
      };
    }
    case "slack.post_message": {
      const channel = (dest.slackChannel ?? dest.slackUserId)?.trim();
      if (!channel) {
        return {
          allowed: true,
          ok: false,
          detail: "slack.post_message requires destination.slackChannel or slackUserId",
          result: {},
        };
      }
      if (clients.dryRun || !clients.slack) {
        if (!clients.slack && !clients.dryRun) {
          return {
            allowed: true,
            ok: false,
            detail: "slack credentials not configured",
            result: {},
          };
        }
        return {
          allowed: true,
          ok: true,
          detail: `dry-run slack message to ${channel}`,
          result: { dryRun: true, channel },
        };
      }
      const data = await clients.slack("chat.postMessage", {
        channel,
        text: input.body.slice(0, 40_000),
        unfurl_links: false,
      });
      return {
        allowed: true,
        ok: true,
        detail: `posted to ${channel}`,
        result: { channel, ts: data.ts },
      };
    }
    case "email.send": {
      const to = (dest.emailTo ?? []).map((e) => e.trim()).filter(Boolean);
      const subject = (dest.emailSubject ?? input.title).trim();
      if (to.length === 0) {
        return {
          allowed: true,
          ok: false,
          detail: "email.send requires destination.emailTo",
          result: {},
        };
      }
      if (clients.dryRun) {
        return {
          allowed: true,
          ok: true,
          detail: `dry-run email to ${to.join(",")}`,
          result: { dryRun: true, to, subject },
        };
      }
      if (!clients.email) {
        return {
          allowed: true,
          ok: false,
          detail: "email sending is not configured (no SES / email client)",
          result: { to, subject },
        };
      }
      const sent = await clients.email({ to, subject, body: input.body });
      return {
        allowed: true,
        ok: true,
        detail: `emailed ${to.join(",")}`,
        result: { to, subject, messageId: sent.messageId },
      };
    }
    case "document.approve": {
      // Documents have no external system in v1 — approval files the content
      // as an executed outcome for the routing/progress trail.
      return {
        allowed: true,
        ok: true,
        detail: `document approved: ${input.title}`,
        result: { title: input.title, bodyChars: input.body.length },
      };
    }
  }
}

/** Map a workflow_actions.kind to the executor's named action. */
export function actionNameForKind(
  kind: "jira_issue" | "slack_message" | "email" | "document",
): ExecutorActionName {
  switch (kind) {
    case "jira_issue":
      return "jira.create_issue";
    case "slack_message":
      return "slack.post_message";
    case "email":
      return "email.send";
    case "document":
      return "document.approve";
  }
}

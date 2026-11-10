/**
 * Minimal Slack Web API helper for ownership DMs (project-ownership).
 * Mirrors the worker's form-urlencoded client without pulling the worker package.
 * Best-effort: missing token or slackUserId skips with a log; never throws to callers
 * who wrap sendOwnershipNotifications.
 */
import type { OwnershipNotifyChange } from "@second-brain/schema";

async function slackApi(
  method: string,
  params: Record<string, string | boolean>,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn(JSON.stringify({ msg: "ownership notify skipped: SLACK_BOT_TOKEN unset" }));
    return;
  }
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`slack ${method}: HTTP ${res.status}`);
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`slack ${method}: ${data.error}`);
}

function roleLabel(role: OwnershipNotifyChange["role"]): string {
  return role === "poc" ? "primary POC" : "backup POC";
}

function messageFor(change: OwnershipNotifyChange, baseUrl: string): string {
  const link = `${baseUrl.replace(/\/$/, "")}/projects/${encodeURIComponent(change.projectSlug)}`;
  if (change.kind === "assigned") {
    return `You were assigned as *${roleLabel(change.role)}* for *${change.projectName}*.\n${link}`;
  }
  return `You are no longer *${roleLabel(change.role)}* for *${change.projectName}*.\n${link}`;
}

/**
 * Send ownership assign/remove DMs. Skips people without slackUserId (logged).
 * Individual send failures are logged; the function does not throw.
 */
export async function sendOwnershipNotifications(
  changes: OwnershipNotifyChange[],
  baseUrl = process.env.APP_BASE_URL ?? "https://brain.local",
): Promise<void> {
  for (const change of changes) {
    if (!change.slackUserId) {
      console.warn(
        JSON.stringify({
          msg: "ownership notify skipped: no slackUserId",
          personId: change.personId,
          projectId: change.projectId,
          role: change.role,
          kind: change.kind,
        }),
      );
      continue;
    }
    try {
      await slackApi("chat.postMessage", {
        channel: change.slackUserId,
        text: messageFor(change, baseUrl),
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: "ownership notify DM failed",
          personId: change.personId,
          projectId: change.projectId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

/**
 * Connector health derived purely from sync_runs history
 * (connector-observability spec) — the web knows nothing about worker
 * credentials or scheduling.
 */

/** Must match the worker scheduler's source list (worker/src/index.ts). */
export const CONNECTOR_SOURCES = ["slack", "gitlab", "jira", "gws"] as const;
export type ConnectorSource = (typeof CONNECTOR_SOURCES)[number];

export type ConnectorHealth = "healthy" | "failing" | "stale" | "never synced";

/** 2× the default 1-hour sync interval; hardcoded until someone tunes intervals. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function deriveConnectorHealth(
  latestRun: { status: "ok" | "failed"; startedAt: Date } | undefined,
  now: Date = new Date(),
): ConnectorHealth {
  if (!latestRun) return "never synced";
  if (latestRun.status === "failed") return "failing";
  if (now.getTime() - latestRun.startedAt.getTime() > STALE_AFTER_MS) return "stale";
  return "healthy";
}

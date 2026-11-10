import {
  CalendarDays,
  Database,
  GitMerge,
  HardDrive,
  ListTodo,
  MessageSquare,
  SquareKanban,
  type LucideIcon,
} from "lucide-react";
import { getHealth, type CheckStatus } from "@/lib/health";
import {
  deriveConnectorHealth,
  CONNECTOR_SOURCES,
  type ConnectorHealth,
  type ConnectorSource,
} from "@/lib/connector-health";
import { connectorRuns, type SyncRunRow } from "@/lib/queries";

export const dynamic = "force-dynamic";

function StatusPill({ status }: { status: CheckStatus }) {
  const ok = status === "ok";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        color: ok ? "var(--pkts-color-light-primary)" : "var(--pkts-color-light-error)",
        border: `1px solid ${ok ? "var(--pkts-color-light-primary)" : "var(--pkts-color-light-error)"}`,
      }}
    >
      {ok ? "connected" : "unreachable"}
    </span>
  );
}

/** Same palette as the project status dots in globals.css. */
const HEALTH_COLORS: Record<ConnectorHealth, string> = {
  healthy: "#1a7f37",
  stale: "#d4a72c",
  failing: "var(--pkts-color-light-error)",
  "never synced": "rgba(17, 42, 77, 0.35)",
};

function HealthPill({ health }: { health: ConnectorHealth }) {
  const color = HEALTH_COLORS[health];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 600,
        color,
        border: `1px solid ${color}`,
      }}
    >
      {health}
    </span>
  );
}

const CONNECTOR_META: Record<ConnectorSource, { name: string; detail: string; icon: LucideIcon }> =
  {
    slack: { name: "Slack", detail: "channels + threads", icon: MessageSquare },
    gitlab: { name: "GitLab", detail: "issues, MRs, milestones", icon: GitMerge },
    jira: { name: "Jira", detail: "issues + epics", icon: SquareKanban },
    gws: { name: "Google Workspace", detail: "calendar + watched-folder transcripts", icon: CalendarDays },
  };

function formatWhen(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function formatCounts(counts: Record<string, unknown>): string {
  const parts = Object.entries(counts)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? parts.join(" · ") : "no counts";
}

function RunLine({ run }: { run: SyncRunRow }) {
  const failed = run.status === "failed";
  return (
    <li
      style={{
        display: "flex",
        gap: 8,
        fontSize: 12,
        padding: "4px 0",
        borderTop: "1px solid rgba(17, 42, 77, 0.08)",
        alignItems: "baseline",
      }}
    >
      <span style={{ whiteSpace: "nowrap", color: "rgba(17, 42, 77, 0.65)" }}>
        {formatWhen(run.startedAt)}
      </span>
      <span
        style={{
          fontWeight: 700,
          color: failed ? "var(--pkts-color-light-error)" : "#1a7f37",
        }}
      >
        {run.status}
      </span>
      <span style={{ color: "rgba(17, 42, 77, 0.65)" }}>
        {failed ? run.error ?? "unknown error" : formatCounts(run.counts)}
        {" · "}
        {(run.durationMs / 1000).toFixed(1)}s
      </span>
    </li>
  );
}

function ConnectorCard({ source, runs }: { source: ConnectorSource; runs: SyncRunRow[] }) {
  const { name, detail, icon: Icon } = CONNECTOR_META[source];
  const latest = runs[0];
  const health = deriveConnectorHealth(latest);
  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon size={20} color="var(--sb-interactive)" strokeWidth={1.75} />
          <strong>{name}</strong>
        </div>
        <HealthPill health={health} />
      </div>
      <div style={{ fontSize: 13, color: "rgba(17, 42, 77, 0.65)", marginBottom: 12 }}>
        {detail}
      </div>
      {latest ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {runs.map((run) => (
            <RunLine key={run.id} run={run} />
          ))}
        </ul>
      ) : (
        <div style={{ fontSize: 12, color: "rgba(17, 42, 77, 0.45)" }}>
          No sync runs recorded yet.
        </div>
      )}
    </div>
  );
}

export default async function StatusPage() {
  const [health, runsBySource] = await Promise.all([getHealth(), connectorRuns()]);
  const checks = [
    { name: "Postgres", detail: "knowledge store", status: health.db, icon: Database },
    { name: "Object store", detail: "raw artifacts (S3/MinIO)", status: health.storage, icon: HardDrive },
    { name: "Job queue", detail: "funnel + agent jobs (SQS/ElasticMQ)", status: health.queue, icon: ListTodo },
  ];

  return (
    <>
      <h1 className="page-title">System status</h1>
      <p className="page-subtitle">Platform dependencies · checked {health.checkedAt}</p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 16,
          maxWidth: 860,
        }}
      >
        {checks.map(({ name, detail, status, icon: Icon }) => (
          <div key={name} className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <Icon size={20} color="var(--sb-interactive)" strokeWidth={1.75} />
              <strong>{name}</strong>
            </div>
            <div style={{ fontSize: 13, color: "rgba(17, 42, 77, 0.65)", marginBottom: 12 }}>
              {detail}
            </div>
            <StatusPill status={status} />
          </div>
        ))}
      </div>

      <h2 className="page-title" style={{ fontSize: 20, marginTop: 32 }}>
        Connectors
      </h2>
      <p className="page-subtitle">
        Ingestion health and recent sync runs · stale after 2h without a run
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
          gap: 16,
          maxWidth: 860,
        }}
      >
        {CONNECTOR_SOURCES.map((source) => (
          <ConnectorCard key={source} source={source} runs={runsBySource.get(source) ?? []} />
        ))}
      </div>
    </>
  );
}

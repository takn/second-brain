/**
 * Ops: wipe derived app data and prime connector cursors for a historical
 * backfill (task 7.4). Keeps seeded entity registry (teams/people/projects/repos).
 *
 * Usage (ECS one-off, same pattern as migrate):
 *   BACKFILL_SINCE=2026-05-01T00:00:00.000Z \
 *     node --import tsx ../packages/schema/src/ops/wipe-for-backfill.ts
 *
 * Pair with: empty the S3 raw bucket, purge SQS, set SLACK_BACKFILL_DAYS to
 * cover BACKFILL_SINCE→now, and JIRA_SYNC_DISABLED=true for the first GitLab
 * history pass (so ensureJiraCounterpart does not flood Jira).
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const since = process.env.BACKFILL_SINCE ?? "2026-05-01T00:00:00.000Z";
if (Number.isNaN(Date.parse(since))) {
  console.error(`BACKFILL_SINCE is not a valid ISO date: ${since}`);
  process.exit(1);
}

const sql = postgres(url, { max: 2 });

async function main() {
  console.log(JSON.stringify({ action: "wipe-derived", keep: ["teams", "people", "projects", "repos"] }));

  // Order doesn't matter with CASCADE; list children for clarity.
  await sql.unsafe(`
    TRUNCATE TABLE
      executor_audit,
      workflow_actions,
      workflow_subtasks,
      workflow_requests,
      analyses,
      brain_queries,
      reports,
      rejections,
      dependencies,
      lint_findings,
      untracked_work,
      contradictions,
      narrative_citations,
      narrative_revisions,
      narratives,
      event_projects,
      events,
      triage_decisions,
      parked_artifacts,
      jira_sync_links,
      work_items,
      milestones,
      project_follows,
      slack_threads,
      slack_channels,
      connector_state,
      sync_runs,
      llm_calls,
      raw_artifacts,
      app_meta
    RESTART IDENTITY CASCADE
  `);

  console.log(JSON.stringify({ action: "prime-cursors", since }));

  const cursorPayloads = [
    { key: "gitlab:reconcile-cursor", value: { updatedAfter: since } },
    { key: "jira:reconcile-cursor", value: { updatedAfter: since } },
    {
      key: "gws:sync-cursor",
      value: { driveSince: since, calendarSince: since },
    },
  ];
  for (const row of cursorPayloads) {
    await sql`
      INSERT INTO connector_state (key, value, updated_at)
      VALUES (${row.key}, ${sql.json(row.value)}, now())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = now()
    `;
  }

  const counts = await sql`
    SELECT 'teams' AS t, count(*)::int AS n FROM teams
    UNION ALL SELECT 'people', count(*)::int FROM people
    UNION ALL SELECT 'projects', count(*)::int FROM projects
    UNION ALL SELECT 'repos', count(*)::int FROM repos
    UNION ALL SELECT 'raw_artifacts', count(*)::int FROM raw_artifacts
    UNION ALL SELECT 'events', count(*)::int FROM events
    UNION ALL SELECT 'connector_state', count(*)::int FROM connector_state
  `;
  console.log(JSON.stringify({ action: "done", since, counts }));
}

try {
  await main();
} finally {
  await sql.end();
}

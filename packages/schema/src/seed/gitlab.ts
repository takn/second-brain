/**
 * Seed entity data from the root GitLab group (domain-model task 2.4),
 * set via GITLAB_ROOT_GROUP.
 *
 * Mapping (expected group layout):
 *   <root>/<team>                   → teams        (first-level subgroups)
 *   <root>/<team>/<project>         → projects     (second-level subgroups)
 *   deeper subgroups                → belong to their second-level ancestor
 *   repositories                    → repos, linked to the project (or team
 *                                     when they sit directly under one)
 *   group members (humans, active)  → people
 *
 * Idempotent: rows are upserted on their GitLab identifiers, so re-running
 * refreshes names/paths without duplicating. POC assignments and org levels
 * are curated by humans (or the future directory sync) — never overwritten.
 *
 * Usage: GITLAB_TOKEN=<token> [DATABASE_URL=…] pnpm --filter @second-brain/schema seed
 */
import { sql as dsql } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { people, projects, repos, teams } from "../db/schema.ts";

const GITLAB_API = process.env.GITLAB_API ?? "https://gitlab.com/api/v4";
const ROOT_GROUP = process.env.GITLAB_ROOT_GROUP ?? process.env.SEED_GROUP ?? "";

const token = process.env.GITLAB_TOKEN;
if (!token) {
  console.error("GITLAB_TOKEN is not set (needs read_api on the root group)");
  process.exit(1);
}
if (!ROOT_GROUP) {
  console.error("GITLAB_ROOT_GROUP is not set (the group whose subgroups map to teams/projects)");
  process.exit(1);
}

async function fetchAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${GITLAB_API}${path}${sep}per_page=100&page=${page}`, {
      headers: { "PRIVATE-TOKEN": token! },
    });
    if (!res.ok) throw new Error(`GET ${path} page ${page}: ${res.status} ${await res.text()}`);
    const batch = (await res.json()) as T[];
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

interface GitlabGroup {
  id: number;
  name: string;
  full_path: string;
}

interface GitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  default_branch: string | null;
  web_url: string;
  archived: boolean;
  namespace: { full_path: string };
}

interface GitlabMember {
  id: number;
  username: string;
  name: string;
  state: string;
}

/** GitLab service accounts look like project_123_bot_abc / group_123_bot_abc. */
function isBot(username: string): boolean {
  return /^(project|group)_\d+_bot/.test(username) || username.endsWith("_bot");
}

const { db, sql } = createDb();
try {
  console.log(`seeding from ${GITLAB_API} group ${ROOT_GROUP}…`);

  const groups = await fetchAll<GitlabGroup>(`/groups/${ROOT_GROUP}/descendant_groups`);
  const gitlabProjects = await fetchAll<GitlabProject>(
    `/groups/${ROOT_GROUP}/projects?include_subgroups=true`,
  );
  const members = await fetchAll<GitlabMember>(`/groups/${ROOT_GROUP}/members/all`);

  // --- Teams: first-level subgroups (<root>/<team>) ---
  const teamGroups = groups.filter((g) => g.full_path.split("/").length === 2);
  const teamIdBySlug = new Map<string, string>();
  for (const g of teamGroups) {
    const slug = g.full_path.split("/")[1]!;
    const [row] = await db
      .insert(teams)
      .values({ slug, name: g.name, gitlabGroupId: g.id })
      .onConflictDoUpdate({
        target: teams.gitlabGroupId,
        set: { slug, name: g.name, updatedAt: dsql`now()` },
      })
      .returning({ id: teams.id });
    teamIdBySlug.set(slug, row!.id);
  }

  // --- Projects: second-level subgroups (<root>/<team>/<project>) ---
  const projectGroups = groups.filter((g) => g.full_path.split("/").length === 3);
  const projectIdBySlug = new Map<string, string>();
  for (const g of projectGroups) {
    const [, teamSlug, projectPath] = g.full_path.split("/");
    const slug = `${teamSlug}/${projectPath}`;
    const [row] = await db
      .insert(projects)
      .values({ slug, name: g.name, teamId: teamIdBySlug.get(teamSlug!), gitlabGroupId: g.id })
      .onConflictDoUpdate({
        target: projects.gitlabGroupId,
        set: {
          slug,
          name: g.name,
          teamId: teamIdBySlug.get(teamSlug!),
          updatedAt: dsql`now()`,
        },
      })
      .returning({ id: projects.id });
    projectIdBySlug.set(slug, row!.id);
  }

  // --- Repos: linked to the enclosing project, or team when no project between ---
  let repoCount = 0;
  for (const p of gitlabProjects) {
    const ns = p.namespace.full_path.split("/"); // e.g. ["<root>", "<team>", "<project>", …]
    const teamId = ns.length >= 2 ? teamIdBySlug.get(ns[1]!) : undefined;
    const projectId = ns.length >= 3 ? projectIdBySlug.get(`${ns[1]}/${ns[2]}`) : undefined;
    await db
      .insert(repos)
      .values({
        gitlabProjectId: p.id,
        path: p.path_with_namespace,
        name: p.name,
        projectId,
        teamId: projectId ? undefined : teamId,
        defaultBranch: p.default_branch,
        webUrl: p.web_url,
        archived: p.archived,
      })
      .onConflictDoUpdate({
        target: repos.gitlabProjectId,
        set: {
          path: p.path_with_namespace,
          name: p.name,
          projectId: projectId ?? null,
          teamId: projectId ? null : (teamId ?? null),
          defaultBranch: p.default_branch,
          webUrl: p.web_url,
          archived: p.archived,
          updatedAt: dsql`now()`,
        },
      });
    repoCount++;
  }

  // --- People: active human members. orgLevel/team/POC stay human-curated. ---
  const humans = members.filter((m) => m.state === "active" && !isBot(m.username));
  const seen = new Set<string>();
  let peopleCount = 0;
  for (const m of humans) {
    if (seen.has(m.username)) continue; // members/all can repeat users across levels
    seen.add(m.username);
    await db
      .insert(people)
      .values({ displayName: m.name, gitlabUsername: m.username })
      .onConflictDoUpdate({
        target: people.gitlabUsername,
        set: { displayName: m.name, updatedAt: dsql`now()` },
      });
    peopleCount++;
  }

  console.log(
    `seeded ${teamIdBySlug.size} teams, ${projectIdBySlug.size} projects, ${repoCount} repos, ${peopleCount} people`,
  );
} finally {
  await sql.end();
}

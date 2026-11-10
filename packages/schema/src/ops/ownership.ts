import { eq, inArray } from "drizzle-orm";
import { people, projects } from "../db/schema.ts";
import {
  InvalidOperationError,
  NotAuthorizedError,
  NotFoundError,
  type Db,
} from "./rejections.ts";

export type OwnershipRole = "poc" | "backup";

/** One person/role delta produced by an ownership change (for notify). */
export interface OwnershipNotifyChange {
  projectId: string;
  projectName: string;
  projectSlug: string;
  role: OwnershipRole;
  kind: "assigned" | "removed";
  personId: string;
  personDisplayName: string;
  slackUserId: string | null;
}

export type OwnershipNotify = (changes: OwnershipNotifyChange[]) => Promise<void> | void;

/**
 * Assign or clear a project's primary and/or backup POC (project-ownership).
 * L1-only. Primary and backup must differ when both set. People must be active.
 * Seed never touches these fields — this is the curated write path.
 */
export async function assignProjectOwnership(
  db: Db,
  input: {
    projectId: string;
    actorPersonId: string;
    /** null clears; omit to leave unchanged. */
    pocId?: string | null;
    /** null clears; omit to leave unchanged. */
    backupPocId?: string | null;
    /** Best-effort post-commit notify; failures must not roll back the write. */
    notify?: OwnershipNotify;
  },
): Promise<{
  pocId: string | null;
  backupPocId: string | null;
  changes: OwnershipNotifyChange[];
}> {
  if (input.pocId === undefined && input.backupPocId === undefined) {
    throw new InvalidOperationError("must set or clear at least one of pocId or backupPocId");
  }

  const [actor] = await db.select().from(people).where(eq(people.id, input.actorPersonId));
  if (!actor || !actor.active || actor.orgLevel !== "L1") {
    throw new NotAuthorizedError("only L1 can assign project ownership");
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId));
  if (!project) throw new NotFoundError("project not found");

  const nextPocId = input.pocId !== undefined ? input.pocId : project.pocId;
  const nextBackupId =
    input.backupPocId !== undefined ? input.backupPocId : project.backupPocId;

  if (nextPocId && nextBackupId && nextPocId === nextBackupId) {
    throw new InvalidOperationError("primary and backup POC must be different people");
  }

  const idsToCheck = [nextPocId, nextBackupId].filter((id): id is string => Boolean(id));
  if (idsToCheck.length > 0) {
    const rows = await db.select().from(people).where(inArray(people.id, idsToCheck));
    const byId = new Map(rows.map((p) => [p.id, p]));
    for (const id of idsToCheck) {
      const p = byId.get(id);
      if (!p) throw new InvalidOperationError(`person ${id} not found`);
      if (!p.active) throw new InvalidOperationError(`person ${id} is inactive`);
    }
  }

  if (nextPocId === project.pocId && nextBackupId === project.backupPocId) {
    return { pocId: project.pocId, backupPocId: project.backupPocId, changes: [] };
  }

  await db
    .update(projects)
    .set({
      pocId: nextPocId,
      backupPocId: nextBackupId,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project.id));

  const affectedIds = new Set<string>();
  for (const id of [project.pocId, project.backupPocId, nextPocId, nextBackupId]) {
    if (id) affectedIds.add(id);
  }
  const affected =
    affectedIds.size > 0
      ? await db.select().from(people).where(inArray(people.id, [...affectedIds]))
      : [];
  const personById = new Map(affected.map((p) => [p.id, p]));

  const changes: OwnershipNotifyChange[] = [];
  const push = (
    role: OwnershipRole,
    kind: "assigned" | "removed",
    personId: string,
  ) => {
    const p = personById.get(personId);
    if (!p) return;
    changes.push({
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
      role,
      kind,
      personId: p.id,
      personDisplayName: p.displayName,
      slackUserId: p.slackUserId,
    });
  };

  if (project.pocId !== nextPocId) {
    if (project.pocId) push("poc", "removed", project.pocId);
    if (nextPocId) push("poc", "assigned", nextPocId);
  }
  if (project.backupPocId !== nextBackupId) {
    if (project.backupPocId) push("backup", "removed", project.backupPocId);
    if (nextBackupId) push("backup", "assigned", nextBackupId);
  }

  if (input.notify && changes.length > 0) {
    try {
      await input.notify(changes);
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: "ownership notify failed; assignment kept",
          projectId: project.id,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return { pocId: nextPocId, backupPocId: nextBackupId, changes };
}

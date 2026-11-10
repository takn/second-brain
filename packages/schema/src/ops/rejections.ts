import { and, desc, eq, lt, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase, PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type * as schema from "../db/schema.ts";
import {
  eventProjects,
  events,
  narrativeCitations,
  narrativeRevisions,
  narratives,
  people,
  projects,
  rejections,
  untrackedWork,
} from "../db/schema.ts";

/** Accepts either the database handle or an in-flight transaction. */
export type Db =
  | PostgresJsDatabase<typeof schema>
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

export class NotFoundError extends Error {}
export class NotAuthorizedError extends Error {}
export class InvalidOperationError extends Error {}

/** A queued follow-up: the named project's narrative must be re-synthesized. */
export interface ResynthesisRequest {
  kind: "synthesize";
  projectId: string;
}

type Enqueue = (jobs: ResynthesisRequest[]) => Promise<void> | void;

/** Unwraps `.returning()` results, which always contain the inserted row. */
function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("insert returned no row");
  return row;
}

/**
 * Reject permission (design D4): the project's POC, the backup POC, or any L1
 * user. `projectIds` are the projects the change touches; membership in any
 * one of them suffices.
 */
export async function canReject(db: Db, personId: string, projectIds: string[]): Promise<boolean> {
  const [person] = await db.select().from(people).where(eq(people.id, personId));
  if (!person || !person.active) return false;
  if (person.orgLevel === "L1") return true;
  if (projectIds.length === 0) return false;
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.pocId, personId));
  const backup = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.backupPocId, personId));
  const ownedIds = new Set([...owned, ...backup].map((p) => p.id));
  return projectIds.some((id) => ownedIds.has(id));
}

/**
 * Provenance-enforcing event insert: every event references its raw artifact
 * (schema-level NOT NULL) and links to at least one project (enforced here —
 * the join table cannot express "at least one").
 */
export async function createEvent(
  db: Db,
  input: {
    type: (typeof events.$inferInsert)["type"];
    title: string;
    confidence: number;
    artifactId: string;
    projectIds: string[];
    body?: string;
    details?: unknown;
    span?: unknown;
    permalink?: string;
    occurredAt?: Date;
    extractedBy?: string;
    workItemId?: string;
    /** Set for deterministically-derived events; replays upsert instead of duplicating. */
    dedupeKey?: string;
  },
): Promise<{ eventId: string; created: boolean }> {
  if (input.projectIds.length === 0) {
    throw new InvalidOperationError("an event must link to at least one project");
  }
  return db.transaction(async (tx) => {
    if (input.dedupeKey) {
      const [existing] = await tx
        .select({ id: events.id })
        .from(events)
        .where(eq(events.dedupeKey, input.dedupeKey));
      if (existing) return { eventId: existing.id, created: false };
    }
    const event = one(
      await tx
        .insert(events)
        .values({
          type: input.type,
          title: input.title,
          confidence: input.confidence,
          artifactId: input.artifactId,
          body: input.body,
          details: input.details ?? {},
          span: input.span,
          permalink: input.permalink,
          occurredAt: input.occurredAt,
          extractedBy: input.extractedBy,
          workItemId: input.workItemId,
          dedupeKey: input.dedupeKey,
        })
        .returning({ id: events.id }),
    );
    await tx
      .insert(eventProjects)
      .values(input.projectIds.map((projectId) => ({ eventId: event.id, projectId })));
    return { eventId: event.id, created: true };
  });
}

/**
 * Append a narrative revision: auto-increments the revision number, records
 * the event citations (provenance chain), and moves the head pointer.
 */
export async function createNarrativeRevision(
  db: Db,
  input: {
    narrativeId: string;
    body: string;
    citedEventIds: string[];
    summary?: string;
    createdBy?: string;
  },
): Promise<{ revisionId: string; revision: number }> {
  return db.transaction(async (tx) => {
    const [narrative] = await tx
      .select()
      .from(narratives)
      .where(eq(narratives.id, input.narrativeId));
    if (!narrative) throw new NotFoundError(`narrative ${input.narrativeId} not found`);

    const [latest] = await tx
      .select({ revision: narrativeRevisions.revision })
      .from(narrativeRevisions)
      .where(eq(narrativeRevisions.narrativeId, input.narrativeId))
      .orderBy(desc(narrativeRevisions.revision))
      .limit(1);
    const revision = (latest?.revision ?? 0) + 1;

    const inserted = one(
      await tx
        .insert(narrativeRevisions)
        .values({
          narrativeId: input.narrativeId,
          revision,
          body: input.body,
          summary: input.summary,
          createdBy: input.createdBy ?? "synthesizer",
        })
        .returning({ id: narrativeRevisions.id }),
    );

    if (input.citedEventIds.length > 0) {
      await tx
        .insert(narrativeCitations)
        .values(input.citedEventIds.map((eventId) => ({ revisionId: inserted.id, eventId })));
    }

    await tx
      .update(narratives)
      .set({ currentRevisionId: inserted.id, updatedAt: new Date() })
      .where(eq(narratives.id, input.narrativeId));

    return { revisionId: inserted.id, revision };
  });
}

/**
 * Reject an extracted event (domain-model spec: Rejection model).
 * Removes it from current-state views (status → rejected), dismisses any
 * untracked-work record hanging off it, stores the rejection with a snapshot
 * as correction data, and queues re-synthesis for every linked project.
 */
export async function rejectEvent(
  db: Db,
  input: { eventId: string; personId: string; reason: string; enqueue?: Enqueue },
): Promise<{ rejectionId: string; resynthesisProjectIds: string[] }> {
  const result = await db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, input.eventId));
    if (!event) throw new NotFoundError(`event ${input.eventId} not found`);
    if (event.status === "rejected") {
      throw new InvalidOperationError(`event ${input.eventId} is already rejected`);
    }

    const links = await tx
      .select({ projectId: eventProjects.projectId })
      .from(eventProjects)
      .where(eq(eventProjects.eventId, input.eventId));
    const projectIds = links.map((l) => l.projectId);

    if (!(await canReject(tx, input.personId, projectIds))) {
      throw new NotAuthorizedError("only the project POC, backup POC, or L1 can reject");
    }

    await tx.update(events).set({ status: "rejected" }).where(eq(events.id, input.eventId));
    await tx
      .update(untrackedWork)
      .set({ status: "dismissed", resolvedAt: new Date() })
      .where(and(eq(untrackedWork.eventId, input.eventId), eq(untrackedWork.status, "open")));

    const rejection = one(
      await tx
        .insert(rejections)
        .values({
          targetKind: "event",
          targetId: input.eventId,
          projectId: projectIds[0],
          rejectedById: input.personId,
          reason: input.reason,
          snapshot: event,
        })
        .returning({ id: rejections.id }),
    );

    return { rejectionId: rejection.id, resynthesisProjectIds: projectIds };
  });

  await input.enqueue?.(
    result.resynthesisProjectIds.map((projectId) => ({ kind: "synthesize", projectId })),
  );
  return result;
}

/**
 * Reject a narrative revision (domain-model spec: Versioned narratives —
 * reverting). Only the current head can be rejected; the narrative reverts to
 * the prior revision (which remains retrievable) and re-synthesis is queued.
 */
export async function rejectNarrativeRevision(
  db: Db,
  input: { revisionId: string; personId: string; reason: string; enqueue?: Enqueue },
): Promise<{ rejectionId: string; revertedToRevisionId: string | null; projectId: string }> {
  const result = await db.transaction(async (tx) => {
    const [revision] = await tx
      .select()
      .from(narrativeRevisions)
      .where(eq(narrativeRevisions.id, input.revisionId));
    if (!revision) throw new NotFoundError(`revision ${input.revisionId} not found`);

    const [narrative] = await tx
      .select()
      .from(narratives)
      .where(eq(narratives.id, revision.narrativeId));
    if (!narrative) throw new NotFoundError(`narrative ${revision.narrativeId} not found`);
    if (narrative.currentRevisionId !== input.revisionId) {
      throw new InvalidOperationError("only the current revision can be rejected");
    }

    if (!(await canReject(tx, input.personId, [narrative.projectId]))) {
      throw new NotAuthorizedError("only the project POC, backup POC, or L1 can reject");
    }

    const [prior] = await tx
      .select()
      .from(narrativeRevisions)
      .where(
        and(
          eq(narrativeRevisions.narrativeId, revision.narrativeId),
          lt(narrativeRevisions.revision, revision.revision),
        ),
      )
      .orderBy(desc(narrativeRevisions.revision))
      .limit(1);

    await tx
      .update(narratives)
      .set({ currentRevisionId: prior?.id ?? null, updatedAt: new Date() })
      .where(eq(narratives.id, narrative.id));

    const rejection = one(
      await tx
        .insert(rejections)
        .values({
          targetKind: "narrative_revision",
          targetId: input.revisionId,
          projectId: narrative.projectId,
          rejectedById: input.personId,
          reason: input.reason,
          snapshot: revision,
        })
        .returning({ id: rejections.id }),
    );

    return {
      rejectionId: rejection.id,
      revertedToRevisionId: prior?.id ?? null,
      projectId: narrative.projectId,
    };
  });

  await input.enqueue?.([{ kind: "synthesize", projectId: result.projectId }]);
  return result;
}

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { applyMigrations } from "../db/migrations.ts";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as t from "../db/schema.ts";
import {
  canReject,
  createEvent,
  createNarrativeRevision,
  InvalidOperationError,
  NotAuthorizedError,
  rejectEvent,
  rejectNarrativeRevision,
  type ResynthesisRequest,
} from "./rejections.ts";

const url =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://brain:brain@localhost:54321/brain";

// Integration suite: needs a Postgres (local compose stack or CI service).
// Skips silently when none is reachable so unit runs stay green anywhere.
const probe = postgres(url, { max: 1, connect_timeout: 3 });
let dbUp = false;
try {
  await probe`select 1`;
  dbUp = true;
} catch {
  // leave dbUp false
} finally {
  await probe.end();
}

describe.skipIf(!dbUp)("rejection/revert operations", () => {
  const sql = postgres(url, { max: 5 });
  const db = drizzle(sql, { schema: t });

  // Fixture rows shared by the tests.
  let teamId: string;
  let projectId: string;
  let pocId: string;
  let l1Id: string;
  let bystanderId: string;
  let artifactId: string;

  function person(overrides: Partial<typeof t.people.$inferInsert> = {}) {
    return {
      displayName: `person-${randomUUID().slice(0, 8)}`,
      gitlabUsername: `user-${randomUUID().slice(0, 8)}`,
      ...overrides,
    };
  }

  beforeAll(async () => {
    await applyMigrations(sql);

    const [team] = await db
      .insert(t.teams)
      .values({ slug: `team-${randomUUID().slice(0, 8)}`, name: "Test Team" })
      .returning();
    teamId = team!.id;

    const [poc] = await db.insert(t.people).values(person({ orgLevel: "L2" })).returning();
    const [l1] = await db.insert(t.people).values(person({ orgLevel: "L1" })).returning();
    const [bystander] = await db.insert(t.people).values(person({ orgLevel: "L2" })).returning();
    pocId = poc!.id;
    l1Id = l1!.id;
    bystanderId = bystander!.id;

    const [project] = await db
      .insert(t.projects)
      .values({
        slug: `proj-${randomUUID().slice(0, 8)}`,
        name: "Test Project",
        teamId,
        pocId,
      })
      .returning();
    projectId = project!.id;

    const [artifact] = await db
      .insert(t.rawArtifacts)
      .values({
        source: "slack",
        sourceKey: `C123:${randomUUID()}`,
        objectKey: "raw/slack/test.json",
      })
      .returning();
    artifactId = artifact!.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function makeEvent() {
    const { eventId } = await createEvent(db, {
      type: "action_item",
      title: "Follow up on the thing",
      confidence: 0.9,
      artifactId,
      projectIds: [projectId],
      permalink: "https://example.slack.com/archives/C123/p1",
    });
    return eventId;
  }

  it("refuses to create an event with no project link", async () => {
    await expect(
      createEvent(db, {
        type: "decision",
        title: "orphan",
        confidence: 0.5,
        artifactId,
        projectIds: [],
      }),
    ).rejects.toThrow(InvalidOperationError);
  });

  it("creates events carrying artifact provenance and project links", async () => {
    const eventId = await makeEvent();
    const [row] = await db.select().from(t.events).where(eq(t.events.id, eventId));
    expect(row!.artifactId).toBe(artifactId);
    const links = await db
      .select()
      .from(t.eventProjects)
      .where(eq(t.eventProjects.eventId, eventId));
    expect(links.map((l) => l.projectId)).toEqual([projectId]);
  });

  it("grants reject rights to the POC and to L1, denies bystanders", async () => {
    expect(await canReject(db, pocId, [projectId])).toBe(true);
    expect(await canReject(db, l1Id, [projectId])).toBe(true);
    expect(await canReject(db, bystanderId, [projectId])).toBe(false);
  });

  it("denies rejection to a non-POC L2 user", async () => {
    const eventId = await makeEvent();
    await expect(
      rejectEvent(db, { eventId, personId: bystanderId, reason: "nope" }),
    ).rejects.toThrow(NotAuthorizedError);
  });

  it("rejects an event: removes from current state, records rejection, queues re-synthesis", async () => {
    const eventId = await makeEvent();
    // an untracked-work record hanging off the event gets dismissed
    await db
      .insert(t.untrackedWork)
      .values({ eventId, projectId, title: "Follow up on the thing" });

    const queued: ResynthesisRequest[] = [];
    const result = await rejectEvent(db, {
      eventId,
      personId: pocId,
      reason: "hallucinated",
      enqueue: (jobs) => {
        queued.push(...jobs);
      },
    });

    const [event] = await db.select().from(t.events).where(eq(t.events.id, eventId));
    expect(event!.status).toBe("rejected");

    const [rejection] = await db
      .select()
      .from(t.rejections)
      .where(eq(t.rejections.id, result.rejectionId));
    expect(rejection!.reason).toBe("hallucinated");
    expect(rejection!.targetKind).toBe("event");
    expect((rejection!.snapshot as { title: string }).title).toBe("Follow up on the thing");

    const [uw] = await db
      .select()
      .from(t.untrackedWork)
      .where(eq(t.untrackedWork.eventId, eventId));
    expect(uw!.status).toBe("dismissed");

    expect(queued).toEqual([{ kind: "synthesize", projectId }]);
  });

  it("refuses to reject an already-rejected event", async () => {
    const eventId = await makeEvent();
    await rejectEvent(db, { eventId, personId: l1Id, reason: "first" });
    await expect(rejectEvent(db, { eventId, personId: l1Id, reason: "again" })).rejects.toThrow(
      InvalidOperationError,
    );
  });

  it("versions narratives with citations and reverts on rejection", async () => {
    const eventId = await makeEvent();
    const [narrative] = await db
      .insert(t.narratives)
      .values({ projectId, kind: "status" })
      .returning();
    const narrativeId = narrative!.id;

    const r1 = await createNarrativeRevision(db, {
      narrativeId,
      body: "All quiet.",
      citedEventIds: [],
    });
    const r2 = await createNarrativeRevision(db, {
      narrativeId,
      body: "New action item surfaced.",
      citedEventIds: [eventId],
    });
    expect(r1.revision).toBe(1);
    expect(r2.revision).toBe(2);

    const citations = await db
      .select()
      .from(t.narrativeCitations)
      .where(eq(t.narrativeCitations.revisionId, r2.revisionId));
    expect(citations.map((c) => c.eventId)).toEqual([eventId]);

    // only the head revision can be rejected
    await expect(
      rejectNarrativeRevision(db, { revisionId: r1.revisionId, personId: pocId, reason: "old" }),
    ).rejects.toThrow(InvalidOperationError);

    const queued: ResynthesisRequest[] = [];
    const result = await rejectNarrativeRevision(db, {
      revisionId: r2.revisionId,
      personId: pocId,
      reason: "misreads the thread",
      enqueue: (jobs) => {
        queued.push(...jobs);
      },
    });
    expect(result.revertedToRevisionId).toBe(r1.revisionId);
    expect(queued).toEqual([{ kind: "synthesize", projectId }]);

    const [after] = await db.select().from(t.narratives).where(eq(t.narratives.id, narrativeId));
    expect(after!.currentRevisionId).toBe(r1.revisionId);

    // the rejected revision remains retrievable history
    const [kept] = await db
      .select()
      .from(t.narrativeRevisions)
      .where(eq(t.narrativeRevisions.id, r2.revisionId));
    expect(kept!.body).toBe("New action item surfaced.");
  });
});

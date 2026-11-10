import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../db/migrations.ts";
import * as t from "../db/schema.ts";
import {
  InvalidOperationError,
  NotAuthorizedError,
  NotFoundError,
  canReject,
} from "./rejections.ts";
import {
  assignProjectOwnership,
  type OwnershipNotifyChange,
} from "./ownership.ts";

const url =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://brain:brain@localhost:54321/brain";

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

describe.skipIf(!dbUp)("project ownership assignment", () => {
  const sql = postgres(url, { max: 5 });
  const db = drizzle(sql, { schema: t });

  let teamId: string;
  let projectId: string;
  let l1Id: string;
  let l2Id: string;
  let otherId: string;
  let inactiveId: string;

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
      .values({ slug: `team-${randomUUID().slice(0, 8)}`, name: "Ownership Team" })
      .returning();
    teamId = team!.id;

    const [l1] = await db.insert(t.people).values(person({ orgLevel: "L1" })).returning();
    const [l2] = await db.insert(t.people).values(person({ orgLevel: "L2" })).returning();
    const [other] = await db.insert(t.people).values(person({ orgLevel: "L2" })).returning();
    const [inactive] = await db
      .insert(t.people)
      .values(person({ orgLevel: "L2", active: false }))
      .returning();
    l1Id = l1!.id;
    l2Id = l2!.id;
    otherId = other!.id;
    inactiveId = inactive!.id;

    const [project] = await db
      .insert(t.projects)
      .values({
        slug: `proj-${randomUUID().slice(0, 8)}`,
        name: "Ownership Project",
        teamId,
      })
      .returning();
    projectId = project!.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("assigns primary and backup POC for an L1 actor", async () => {
    const result = await assignProjectOwnership(db, {
      projectId,
      actorPersonId: l1Id,
      pocId: l2Id,
      backupPocId: otherId,
    });
    expect(result.pocId).toBe(l2Id);
    expect(result.backupPocId).toBe(otherId);

    const [row] = await db.select().from(t.projects).where(eq(t.projects.id, projectId));
    expect(row!.pocId).toBe(l2Id);
    expect(row!.backupPocId).toBe(otherId);
  });

  it("replaces primary POC and records assign + remove changes", async () => {
    await assignProjectOwnership(db, {
      projectId,
      actorPersonId: l1Id,
      pocId: l2Id,
      backupPocId: null,
    });

    const notified: OwnershipNotifyChange[] = [];
    const result = await assignProjectOwnership(db, {
      projectId,
      actorPersonId: l1Id,
      pocId: otherId,
      notify: (changes) => {
        notified.push(...changes);
      },
    });

    expect(result.pocId).toBe(otherId);
    expect(notified.map((c) => `${c.kind}:${c.role}:${c.personId}`).sort()).toEqual(
      [`assigned:poc:${otherId}`, `removed:poc:${l2Id}`].sort(),
    );
  });

  it("clears POC fields when set to null", async () => {
    await assignProjectOwnership(db, {
      projectId,
      actorPersonId: l1Id,
      pocId: l2Id,
      backupPocId: otherId,
    });
    const result = await assignProjectOwnership(db, {
      projectId,
      actorPersonId: l1Id,
      pocId: null,
      backupPocId: null,
    });
    expect(result.pocId).toBeNull();
    expect(result.backupPocId).toBeNull();
    const [row] = await db.select().from(t.projects).where(eq(t.projects.id, projectId));
    expect(row!.pocId).toBeNull();
    expect(row!.backupPocId).toBeNull();
  });

  it("denies non-L1 actors", async () => {
    await expect(
      assignProjectOwnership(db, {
        projectId,
        actorPersonId: l2Id,
        pocId: otherId,
      }),
    ).rejects.toThrow(NotAuthorizedError);
  });

  it("rejects inactive people", async () => {
    await expect(
      assignProjectOwnership(db, {
        projectId,
        actorPersonId: l1Id,
        pocId: inactiveId,
      }),
    ).rejects.toThrow(InvalidOperationError);
  });

  it("rejects identical primary and backup", async () => {
    await expect(
      assignProjectOwnership(db, {
        projectId,
        actorPersonId: l1Id,
        pocId: l2Id,
        backupPocId: l2Id,
      }),
    ).rejects.toThrow(InvalidOperationError);
  });

  it("keeps the assignment when notify throws", async () => {
    await assignProjectOwnership(db, {
      projectId,
      actorPersonId: l1Id,
      pocId: null,
      backupPocId: null,
    });
    await assignProjectOwnership(db, {
      projectId,
      actorPersonId: l1Id,
      pocId: l2Id,
      notify: () => {
        throw new Error("slack down");
      },
    });
    const [row] = await db.select().from(t.projects).where(eq(t.projects.id, projectId));
    expect(row!.pocId).toBe(l2Id);
  });

  it("rejects unknown projects", async () => {
    await expect(
      assignProjectOwnership(db, {
        projectId: randomUUID(),
        actorPersonId: l1Id,
        pocId: l2Id,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("grants reject rights to a newly assigned POC", async () => {
    await assignProjectOwnership(db, {
      projectId,
      actorPersonId: l1Id,
      pocId: null,
      backupPocId: null,
    });
    expect(await canReject(db, otherId, [projectId])).toBe(false);

    await assignProjectOwnership(db, {
      projectId,
      actorPersonId: l1Id,
      pocId: otherId,
    });
    expect(await canReject(db, otherId, [projectId])).toBe(true);
  });
});

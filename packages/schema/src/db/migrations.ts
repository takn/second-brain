import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type postgres from "postgres";

/** Arbitrary app-wide advisory lock id for migration serialization. */
const MIGRATION_LOCK_KEY = 727501;

/**
 * Apply migrations serialized by a Postgres advisory lock, so concurrent
 * callers (parallel test files, multiple booting processes) don't race
 * statements like CREATE TYPE that aren't idempotent under concurrency.
 */
export async function applyMigrations(sql: postgres.Sql): Promise<void> {
  // Advisory locks are per-connection: hold one reserved connection for the
  // lock while the migrator runs on the pool.
  const lock = await sql.reserve();
  try {
    await lock`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    await migrate(drizzle(sql), {
      migrationsFolder: new URL("../../migrations", import.meta.url).pathname,
    });
  } finally {
    await lock`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    lock.release();
  }
}

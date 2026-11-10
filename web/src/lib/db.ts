import { createDb } from "@second-brain/schema";

/** One pool per server process; Next dev hot-reload reuses via globalThis. */
const globalForDb = globalThis as unknown as { __brainDb?: ReturnType<typeof createDb> };

export function db() {
  globalForDb.__brainDb ??= createDb();
  return globalForDb.__brainDb.db;
}

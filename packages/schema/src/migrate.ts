import postgres from "postgres";
import { applyMigrations } from "./db/migrations.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { max: 2 });
try {
  await applyMigrations(sql);
  console.log("migrations applied");
} finally {
  await sql.end();
}

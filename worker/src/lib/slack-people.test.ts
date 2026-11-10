import { randomUUID } from "node:crypto";
import { applyMigrations, tables } from "@second-brain/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectSlackUserIds,
  formatSlackAuthor,
  formatSlackLine,
  formatSlackMessagesForLlm,
  rewriteSlackMentions,
} from "./slack-people.ts";

describe("slack-people rewrite (pure)", () => {
  const names = new Map([
    ["U0AH9E4P085", "Atif (BNL)"],
    ["UABC123", "Ada Lovelace"],
  ]);

  it("collects author and mention ids", () => {
    expect(
      collectSlackUserIds([
        { user: "U0AH9E4P085", text: "ping <@UABC123> and <@UUNKNOWN>" },
        { bot_id: "B1", text: "bot noise" },
      ]).sort(),
    ).toEqual(["U0AH9E4P085", "UABC123", "UUNKNOWN"]);
  });

  it("rewrites known mentions and leaves unknown intact", () => {
    expect(rewriteSlackMentions("ask <@U0AH9E4P085> or <@UZZZ>", names)).toBe(
      "ask @Atif (BNL) or <@UZZZ>",
    );
  });

  it("uses a mention label and replaces bare ids when the name is known", () => {
    expect(rewriteSlackMentions("ping <@UABC123|ada>", names)).toBe("ping @Ada Lovelace");
    expect(rewriteSlackMentions("U0AH9E4P085 received 404 errors", names)).toBe(
      "Atif (BNL) received 404 errors",
    );
  });

  it("formats authors from the people map", () => {
    expect(formatSlackAuthor({ user: "UABC123" }, names)).toBe("Ada Lovelace");
    expect(formatSlackAuthor({ user: "UUNKNOWN" }, names)).toBe("UUNKNOWN");
    expect(formatSlackAuthor({ bot_id: "B1" }, names)).toBe("[bot]");
  });

  it("formats a line with resolved author and mentions", () => {
    expect(
      formatSlackLine(
        { ts: "1.0", user: "U0AH9E4P085", text: "talk to <@UABC123>" },
        names,
        { withTs: true },
      ),
    ).toBe("[1.0] Atif (BNL): talk to @Ada Lovelace");
  });
});

const dbUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://brain:brain@localhost:54321/brain";

const probe = postgres(dbUrl, { max: 1, connect_timeout: 3 });
let stackUp = false;
try {
  await probe`select 1`;
  stackUp = true;
} catch {
  // leave stackUp false
} finally {
  await probe.end();
}

describe.skipIf(!stackUp)("slack-people rewrite (people table)", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  const run = randomUUID().slice(0, 8);
  const linkedId = `ULINK${run}`;
  const unlinkedId = `UUNLK${run}`;

  beforeAll(async () => {
    await applyMigrations(sql);
    await db.insert(tables.people).values({
      displayName: `Rewrite Person ${run}`,
      email: `rewrite-${run}@example.com`,
      slackUserId: linkedId,
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("resolves linked authors/mentions via people.slackUserId", async () => {
    const text = await formatSlackMessagesForLlm(
      { db },
      [
        {
          ts: "10.1",
          user: linkedId,
          text: `please sync with <@${linkedId}> and <@${unlinkedId}>`,
        },
      ],
      { withTs: true },
    );
    expect(text).toBe(
      `[10.1] Rewrite Person ${run}: please sync with @Rewrite Person ${run} and <@${unlinkedId}>`,
    );
  });

  it("falls back to slack_users when the person is not linked", async () => {
    const cachedId = `UCACHE${run}`;
    await db.insert(tables.slackUsers).values({
      id: cachedId,
      displayName: `Cached ${run}`,
    });
    const text = await formatSlackMessagesForLlm(
      { db },
      [{ user: cachedId, text: `${cachedId} could not sign in` }],
    );
    expect(text).toBe(`Cached ${run}: Cached ${run} could not sign in`);
  });
});

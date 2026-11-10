import { randomUUID } from "node:crypto";
import { applyMigrations, createEvent, tables } from "@second-brain/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Client, type WorkerDeps } from "./lib/deps.ts";
import type { Llm, LlmRequest, LlmResponse } from "./lib/llm.ts";
import { generateReport, portfolioReportDue } from "./reporter.ts";

const dbUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://brain:brain@localhost:54321/brain";

process.env.AWS_ACCESS_KEY_ID ??= "brainlocal";
process.env.AWS_SECRET_ACCESS_KEY ??= "brainlocal";

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

describe.skipIf(!stackUp)("reporter", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  let teamAId: string;
  let projectAId: string;
  let projectBId: string;
  let eventAId: string;
  let eventBId: string;

  function makeDeps(llm?: Llm): WorkerDeps {
    return {
      db,
      s3: createS3Client({
        S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000",
        S3_REGION: "us-east-1",
      } as NodeJS.ProcessEnv),
      bucket: process.env.S3_BUCKET_RAW ?? "second-brain-raw",
      enqueue: () => {},
      logger: pino({ level: "silent" }),
      llm,
    };
  }

  /** Llm stub: records requests, returns queued tool inputs in order (last repeats). */
  function fakeLlm(inputs: unknown[]): { llm: Llm; requests: LlmRequest[] } {
    const requests: LlmRequest[] = [];
    const llm = {
      invoke: async (_agent: string, request: LlmRequest) => {
        requests.push(request);
        const input = inputs[Math.min(requests.length - 1, inputs.length - 1)];
        return {
          text: "",
          message: {
            role: "assistant",
            content: [
              { toolUse: { toolUseId: `tu-${requests.length}`, name: "emit_report", input } },
            ],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 100, outputTokens: 100 },
          costUsd: 0.005,
          modelId: "fake",
        } as unknown as LlmResponse;
      },
      spentTodayUsd: async () => 0,
      config: {} as Llm["config"],
    } as unknown as Llm;
    return { llm, requests };
  }

  function validReport(citedIds: string[], title = "Weekly portfolio report") {
    return {
      title,
      body_markdown: `## Executive summary\n\nThings are moving. ${citedIds
        .map((id) => `[event:${id}]`)
        .join(" ")}\n\nLonger prose follows to satisfy the minimum length requirement of the schema.`,
      slides: [
        { title: "Title", bullets: ["Weekly status"] },
        { title: "Summary", bullets: ["Things are moving"] },
        { title: "Outlook", bullets: ["Steady"] },
      ],
      cited_event_ids: citedIds,
    };
  }

  beforeAll(async () => {
    await applyMigrations(sql);
    const run = randomUUID().slice(0, 8);
    const [teamA] = await db
      .insert(tables.teams)
      .values({ slug: `rpt-a-${run}`, name: `Reporter Team A ${run}` })
      .returning();
    teamAId = teamA!.id;
    const [teamB] = await db
      .insert(tables.teams)
      .values({ slug: `rpt-b-${run}`, name: `Reporter Team B ${run}` })
      .returning();

    const [projectA] = await db
      .insert(tables.projects)
      .values({ slug: `rpt-alpha-${run}`, name: `Reporter Alpha ${run}`, teamId: teamAId })
      .returning();
    projectAId = projectA!.id;
    const [projectB] = await db
      .insert(tables.projects)
      .values({ slug: `rpt-beta-${run}`, name: `Reporter Beta ${run}`, teamId: teamB!.id })
      .returning();
    projectBId = projectB!.id;

    const [artifact] = await db
      .insert(tables.rawArtifacts)
      .values({ source: "slack", sourceKey: `rpt:${randomUUID()}`, objectKey: "raw/rpt.json" })
      .returning();

    ({ eventId: eventAId } = await createEvent(db, {
      type: "status_change",
      title: "Alpha shipped the ingest milestone",
      confidence: 0.9,
      artifactId: artifact!.id,
      projectIds: [projectAId],
    }));
    ({ eventId: eventBId } = await createEvent(db, {
      type: "blocker_raised",
      title: "Beta blocked on credentials",
      confidence: 0.8,
      artifactId: artifact!.id,
      projectIds: [projectBId],
    }));
  });

  afterAll(async () => {
    await sql.end();
  });

  it("writes a draft portfolio report citing provided events", async () => {
    const { llm } = fakeLlm([validReport([eventAId, eventBId])]);
    const result = await generateReport(makeDeps(llm), { scope: "portfolio" });
    expect(result.reportId).toBeDefined();

    const [row] = await db
      .select()
      .from(tables.reports)
      .where(eq(tables.reports.id, result.reportId!));
    expect(row!.status).toBe("draft");
    expect(row!.scope).toBe("portfolio");
    expect(row!.citedEventIds).toEqual([eventAId, eventBId]);
    expect((row!.slides as unknown[]).length).toBe(3);
    expect(row!.createdBy).toBe("reporter:fake");
  });

  it("scopes team reports to that team's projects", async () => {
    const { llm, requests } = fakeLlm([validReport([eventAId], "Team A weekly")]);
    const result = await generateReport(makeDeps(llm), { scope: "team", teamId: teamAId });
    expect(result.reportId).toBeDefined();

    const prompt = (requests[0]!.messages[0]!.content?.[0] as { text: string }).text;
    expect(prompt).toContain("Alpha shipped the ingest milestone");
    expect(prompt).not.toContain("Beta blocked on credentials");

    const [row] = await db
      .select({ teamId: tables.reports.teamId, scope: tables.reports.scope })
      .from(tables.reports)
      .where(eq(tables.reports.id, result.reportId!));
    expect(row!.scope).toBe("team");
    expect(row!.teamId).toBe(teamAId);
  });

  it("retries on foreign cited ids, then writes nothing after a second failure", async () => {
    const bogus = validReport([randomUUID()]);
    const { llm, requests } = fakeLlm([bogus, bogus]);
    const before = (await db.select({ id: tables.reports.id }).from(tables.reports)).length;

    const result = await generateReport(makeDeps(llm), { scope: "portfolio" });
    expect(result.skipped).toBe("validation failed twice");
    expect(requests).toHaveLength(2);
    // Retry feedback must answer the tool_use as an error tool_result —
    // Bedrock rejects plain text after an assistant tool call. Message layout:
    // [prompt, assistant attempt 1, feedback 1, assistant attempt 2, feedback 2].
    const retryBlock = requests[1]!.messages[2]!.content?.[0] as {
      toolResult: { toolUseId: string; status: string; content: { text: string }[] };
    };
    expect(retryBlock.toolResult.toolUseId).toBe("tu-1");
    expect(retryBlock.toolResult.status).toBe("error");
    expect(retryBlock.toolResult.content[0]!.text).toContain("failed validation");

    const after = (await db.select({ id: tables.reports.id }).from(tables.reports)).length;
    expect(after).toBe(before);
  });

  it("age guard: due only when the newest portfolio report is stale", async () => {
    // A fresh portfolio report exists from the first test.
    expect(await portfolioReportDue(makeDeps(), 7 * 86_400_000)).toBe(false);
    expect(await portfolioReportDue(makeDeps(), 0)).toBe(true);
  });
});

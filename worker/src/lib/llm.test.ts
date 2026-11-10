import type { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { applyMigrations, tables } from "@second-brain/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExhaustedError, createLlm, llmConfigSchema, loadLlmConfig, type LlmConfig } from "./llm.ts";

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

const config: LlmConfig = {
  tiers: {
    cheap: { modelId: "test.cheap", inputUsdPer1k: 0.001, outputUsdPer1k: 0.005, defaultMaxTokens: 1024 },
    mid: { modelId: "test.mid", inputUsdPer1k: 0.003, outputUsdPer1k: 0.015, defaultMaxTokens: 4096 },
    frontier: { modelId: "test.frontier", inputUsdPer1k: 0.003, outputUsdPer1k: 0.015, defaultMaxTokens: 8192 },
  },
  agents: {
    triage: { tier: "cheap", dailyBudgetUsd: 0.003 },
    extractor: { tier: "mid", dailyBudgetUsd: 10 },
    synthesizer: { tier: "frontier", dailyBudgetUsd: 10 },
    linter: { tier: "mid", dailyBudgetUsd: 5 },
    reporter: { tier: "frontier", dailyBudgetUsd: 5 },
    query: { tier: "frontier", dailyBudgetUsd: 10 },
    workflow: { tier: "frontier", dailyBudgetUsd: 10 },
  },
};

/** Fake Bedrock: fixed usage, captures the ConverseCommand inputs it receives. */
function fakeClient(usage = { inputTokens: 1000, outputTokens: 500 }) {
  const send = vi.fn(async (command: ConverseCommand) => ({
    output: { message: { role: "assistant", content: [{ text: "ok" }] } },
    stopReason: "end_turn",
    usage,
    $metadata: {},
    // capture for assertions
    _input: command.input,
  }));
  return { send, client: { send } as unknown as BedrockRuntimeClient };
}

describe("llm config", () => {
  it("parses the shipped config/llm.json", () => {
    const parsed = loadLlmConfig();
    expect(Object.keys(parsed.agents)).toHaveLength(7);
    expect(parsed.tiers.cheap.defaultMaxTokens).toBeGreaterThan(0);
  });

  it("rejects a config missing an agent", () => {
    const { synthesizer: _dropped, ...partial } = config.agents;
    expect(() => llmConfigSchema.parse({ ...config, agents: partial })).toThrow();
  });
});

describe.skipIf(!stackUp)("llm invocation and budgets", () => {
  const sql = postgres(dbUrl, { max: 5 });
  const db = drizzle(sql, { schema: tables });
  const logger = pino({ level: "silent" });

  beforeAll(async () => {
    await applyMigrations(sql);
  });

  beforeEach(async () => {
    await db.delete(tables.llmCalls);
  });

  afterAll(async () => {
    await sql.end();
  });

  it("routes each agent to its configured tier model", async () => {
    const { send, client } = fakeClient();
    const llm = createLlm({ db, logger, config, client });

    await llm.invoke("extractor", { messages: [{ role: "user", content: [{ text: "hi" }] }] });
    expect(send.mock.calls[0]![0].input.modelId).toBe("test.mid");

    await llm.invoke("synthesizer", { messages: [{ role: "user", content: [{ text: "hi" }] }] });
    expect(send.mock.calls[1]![0].input.modelId).toBe("test.frontier");
  });

  it("always sets maxTokens and clamps it to the tier ceiling", async () => {
    const { send, client } = fakeClient();
    const llm = createLlm({ db, logger, config, client });

    await llm.invoke("extractor", { messages: [{ role: "user", content: [{ text: "hi" }] }] });
    expect(send.mock.calls[0]![0].input.inferenceConfig?.maxTokens).toBe(4096);

    await llm.invoke("extractor", {
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      maxTokens: 999_999,
    });
    expect(send.mock.calls[1]![0].input.inferenceConfig?.maxTokens).toBe(4096);
  });

  it("meters token spend into llm_calls with integer-micro cost", async () => {
    const { client } = fakeClient({ inputTokens: 1000, outputTokens: 500 });
    const llm = createLlm({ db, logger, config, client });

    const res = await llm.invoke("extractor", {
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      purpose: "test",
    });
    // mid tier: 1000 in × $0.003/1k + 500 out × $0.015/1k = $0.0105 = 10500 µUSD
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    expect(res.costUsd).toBeCloseTo(0.0105, 6);

    const rows = await db.select().from(tables.llmCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "extractor",
      modelId: "test.mid",
      inputTokens: 1000,
      outputTokens: 500,
      costMicros: 10500,
      purpose: "test",
    });
    expect(await llm.spentTodayUsd("extractor")).toBeCloseTo(0.0105, 6);
  });

  it("refuses calls once the daily cap is spent, queuing-style error", async () => {
    const { send, client } = fakeClient({ inputTokens: 1000, outputTokens: 500 });
    const llm = createLlm({ db, logger, config, client });
    const messages = [{ role: "user" as const, content: [{ text: "hi" }] }];

    // triage cap is $0.003 (3000 µUSD); first call spends 3500 µUSD (allowed to
    // overshoot), second is refused.
    await llm.invoke("triage", { messages });
    await expect(llm.invoke("triage", { messages })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(send).toHaveBeenCalledTimes(1);

    // Budgets are per-agent: other agents are unaffected.
    await expect(llm.invoke("linter", { messages })).resolves.toBeTruthy();
  });
});

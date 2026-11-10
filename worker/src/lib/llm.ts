/**
 * Amazon Bedrock integration (brain-agents spec: Tiered Bedrock model routing).
 *
 * Config-driven per-agent model tiers, token-spend metering into `llm_calls`,
 * and app-enforced daily budget caps — Bedrock has no per-key budgets, so the
 * worker refuses calls once an agent's UTC-day spend reaches its cap. Callers
 * treat `BudgetExhaustedError` as "re-queue with delay", never as failure.
 */

import { readFileSync } from "node:fs";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { AGENTS, tables, type Agent, type createDb } from "@second-brain/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import { emitEmf } from "./metrics.ts";

const LLM_NAMESPACE = "second-brain/llm";

const tierSchema = z.object({
  /** Bedrock model or cross-region inference profile ID (`us.` prefix). */
  modelId: z.string().min(1),
  /** On-demand pricing, USD per 1K tokens — kept in config because it changes without notice. */
  inputUsdPer1k: z.number().positive(),
  outputUsdPer1k: z.number().positive(),
  /** Explicit cap on every call; unset maxTokens silently reserves the model maximum. */
  defaultMaxTokens: z.number().int().positive(),
});

export const llmConfigSchema = z.object({
  tiers: z.object({ cheap: tierSchema, mid: tierSchema, frontier: tierSchema }),
  agents: z.record(
    z.enum(AGENTS),
    z.object({
      tier: z.enum(["cheap", "mid", "frontier"]),
      dailyBudgetUsd: z.number().positive(),
    }),
  ),
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;

/** Repo-root config/llm.json; the container copies config/ alongside worker/. */
const DEFAULT_CONFIG_URL = new URL("../../../config/llm.json", import.meta.url);

export function loadLlmConfig(path = process.env.LLM_CONFIG_PATH): LlmConfig {
  const raw = readFileSync(path ?? DEFAULT_CONFIG_URL, "utf8");
  return llmConfigSchema.parse(JSON.parse(raw));
}

export class BudgetExhaustedError extends Error {
  constructor(
    readonly agent: Agent,
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(`agent "${agent}" exhausted its daily budget ($${spentUsd.toFixed(4)} of $${capUsd})`);
    this.name = "BudgetExhaustedError";
  }
}

/**
 * Retry-with-feedback continuation for tool-use conversations. Anthropic
 * models require every tool_use block to be answered by a tool_result block
 * in the next message — plain text feedback after an assistant tool call is a
 * Bedrock ValidationException. When the failed attempt used a tool, the
 * feedback rides in an error tool_result; otherwise plain text.
 */
export function retryFeedback(toolUseId: string | undefined, feedback: string): Message {
  if (toolUseId) {
    return {
      role: "user",
      content: [
        { toolResult: { toolUseId, content: [{ text: feedback }], status: "error" } },
      ],
    };
  }
  return { role: "user", content: [{ text: feedback }] };
}

export interface LlmRequest {
  messages: Message[];
  system?: string;
  /** Capped at the tier's defaultMaxTokens. */
  maxTokens?: number;
  temperature?: number;
  /** For structured output / tool use (extractor emits typed events this way). */
  toolConfig?: ToolConfiguration;
  /** Attribution tag recorded on the llm_calls row (job kind, artifact key, …). */
  purpose?: string;
}

export interface LlmResponse {
  text: string;
  message: NonNullable<ConverseCommandOutput["output"]>["message"];
  stopReason: ConverseCommandOutput["stopReason"];
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  modelId: string;
}

export interface Llm {
  invoke: (agent: Agent, request: LlmRequest) => Promise<LlmResponse>;
  /** Sum of estimated spend for the current UTC day, in USD. */
  spentTodayUsd: (agent: Agent) => Promise<number>;
  config: LlmConfig;
}

/** Per-call abort ceiling. Prevents one hung Converse from freezing the poll loop. */
export function llmRequestTimeoutMs(env = process.env): number {
  const raw = Number(env.LLM_REQUEST_TIMEOUT_MS ?? 480_000); // 8 min; synth observed ~5 min
  return Number.isFinite(raw) && raw > 0 ? raw : 480_000;
}

export function createBedrockClient(env = process.env): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: env.BEDROCK_REGION ?? env.AWS_REGION ?? "us-east-1",
    maxAttempts: 5,
    retryMode: "adaptive",
  });
}

export function createLlm(input: {
  db: ReturnType<typeof createDb>["db"];
  logger: Logger;
  config: LlmConfig;
  client?: BedrockRuntimeClient;
}): Llm {
  const { config, logger, db } = input;
  const client = input.client ?? createBedrockClient();

  const utcDayStart = () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  };

  async function spentTodayMicros(agent: Agent): Promise<number> {
    const [row] = await db
      .select({
        total: sql<string>`coalesce(sum(${tables.llmCalls.costMicros}), 0)`,
      })
      .from(tables.llmCalls)
      .where(
        and(eq(tables.llmCalls.agent, agent), gte(tables.llmCalls.createdAt, utcDayStart())),
      );
    return Number(row?.total ?? 0);
  }

  async function invoke(agent: Agent, request: LlmRequest): Promise<LlmResponse> {
    const assignment = config.agents[agent];
    const tier = config.tiers[assignment.tier];

    // Pre-call check: the last call may overshoot the cap by one invocation,
    // which is acceptable — the next call is refused.
    const capMicros = Math.round(assignment.dailyBudgetUsd * 1_000_000);
    const spent = await spentTodayMicros(agent);
    if (spent >= capMicros) {
      throw new BudgetExhaustedError(agent, spent / 1_000_000, assignment.dailyBudgetUsd);
    }

    const commandInput: ConverseCommandInput = {
      modelId: tier.modelId,
      messages: request.messages,
      system: request.system ? [{ text: request.system }] : undefined,
      toolConfig: request.toolConfig,
      inferenceConfig: {
        maxTokens: Math.min(request.maxTokens ?? tier.defaultMaxTokens, tier.defaultMaxTokens),
        temperature: request.temperature,
      },
    };

    const started = Date.now();
    const timeoutMs = llmRequestTimeoutMs();
    let response: ConverseCommandOutput;
    try {
      response = await client.send(new ConverseCommand(commandInput), {
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`bedrock call timed out after ${timeoutMs}ms (agent=${agent})`);
      }
      throw err;
    }
    const latencyMs = Date.now() - started;

    const inputTokens = response.usage?.inputTokens ?? 0;
    const outputTokens = response.usage?.outputTokens ?? 0;
    // USD per 1K tokens → microdollars: tokens × usdPer1k × 1000.
    const costMicros =
      Math.round(inputTokens * tier.inputUsdPer1k * 1000) +
      Math.round(outputTokens * tier.outputUsdPer1k * 1000);

    await db.insert(tables.llmCalls).values({
      agent,
      modelId: tier.modelId,
      inputTokens,
      outputTokens,
      costMicros,
      purpose: request.purpose,
    });

    emitEmf({
      namespace: LLM_NAMESPACE,
      dimensions: { agent, modelId: tier.modelId },
      // Per-agent series plus an all-agents aggregate for alarms; modelId
      // rides along as a queryable log field, not a metric dimension.
      dimensionSets: [["agent"], []],
      metrics: [
        { name: "input_tokens", value: inputTokens },
        { name: "output_tokens", value: outputTokens },
        { name: "cost_micros", value: costMicros, unit: "None" },
        // Dollars for dashboard readability (cost_micros / 1e6).
        { name: "cost_usd", value: costMicros / 1_000_000, unit: "None" },
        { name: "latency", value: latencyMs, unit: "Milliseconds" },
      ],
    });
    logger.debug(
      { agent, modelId: tier.modelId, inputTokens, outputTokens, costMicros, latencyMs },
      "bedrock call metered",
    );

    return {
      text:
        response.output?.message?.content
          ?.map((block) => block.text ?? "")
          .join("") ?? "",
      message: response.output?.message,
      stopReason: response.stopReason,
      usage: { inputTokens, outputTokens },
      costUsd: costMicros / 1_000_000,
      modelId: tier.modelId,
    };
  }

  return {
    invoke,
    spentTodayUsd: async (agent) => (await spentTodayMicros(agent)) / 1_000_000,
    config,
  };
}

/** Emitted when a job is deferred instead of failed; alarmed in Terraform. */
export function recordBudgetDeferral(agent: string): void {
  emitEmf({
    namespace: LLM_NAMESPACE,
    dimensions: { agent },
    dimensionSets: [["agent"], []],
    metrics: [{ name: "budget_deferred", value: 1 }],
  });
}

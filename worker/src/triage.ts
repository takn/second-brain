/**
 * Triage stage (task 3.4): signal vs noise, as cheaply as possible.
 *
 * Two tiers (design D2): free heuristics decide the obvious cases; everything
 * ambiguous goes to the cheap-model classifier. Every decision is recorded in
 * triage_decisions with score, method, and the threshold in force, so
 * operators can sample decisions and tune TRIAGE_THRESHOLD (env, no deploy).
 * With org-wide Slack this is the load-bearing cost valve.
 */
import { tables } from "@second-brain/schema";
import type { WorkerDeps } from "./lib/deps.ts";
import { emitMetric } from "./lib/metrics.ts";
import { formatSlackMessagesForLlm } from "./lib/slack-people.ts";
import type { RawEnvelope } from "./raw.ts";

export interface TriageDecision {
  verdict: "signal" | "noise";
  /** P(signal) in [0,1]. */
  score: number;
  method: string;
  tags: { eventTypes?: string[]; topics?: string[] };
}

export function triageThreshold(): number {
  const t = Number(process.env.TRIAGE_THRESHOLD ?? 0.5);
  return Number.isFinite(t) && t > 0 && t < 1 ? t : 0.5;
}

interface SlackMsg {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
}

/** Wordlist that marks a thread as obvious work signal — free, no model call. */
const SIGNAL_TERMS =
  /\b(deadline|due date|blocke[dr]|blocker|decision|decided|agreed|sign[- ]?off|ship(ping|ped)?|release|slip(ped|ping)?|postponed?|delayed?|milestone|escalat|risk|launch|deliverable|action item|priorit)/i;

/** Free tier: definite noise / definite signal / null = ask the model. */
export function heuristicTriage(messages: SlackMsg[]): TriageDecision | null {
  const human = messages.filter((m) => !m.bot_id && !m.subtype);
  const text = human.map((m) => m.text ?? "").join("\n");

  // Nothing human said (bot chatter, joins/leaves, our own consent notice).
  if (human.length === 0) {
    return { verdict: "noise", score: 0.02, method: "heuristic-noise", tags: {} };
  }
  // Keywords outrank brevity: "deadline slipped to Oct 7" alone is signal.
  if (SIGNAL_TERMS.test(text)) {
    return { verdict: "signal", score: 0.95, method: "heuristic-signal", tags: {} };
  }
  // One trivial message: greetings, emoji, "thanks".
  if (human.length === 1 && text.trim().length < 40) {
    return { verdict: "noise", score: 0.05, method: "heuristic-noise", tags: {} };
  }
  return null;
}

const CLASSIFIER_SYSTEM = `You triage Slack threads for an engineering organization's knowledge base. Decide whether a thread contains work-relevant signal: decisions, blockers, status changes, deadlines, action items, or milestone updates. Social chatter, greetings, memes, and logistics with no project relevance are noise.

Respond with ONLY a JSON object, no prose:
{"signal": <boolean>, "confidence": <0..1, your probability that this thread contains work-relevant signal>, "event_types": [<zero or more of: decision, blocker_raised, blocker_resolved, status_change, deadline_set, deadline_slipped, action_item, milestone_update>], "topics": [<up to 3 short topic strings>]}`;

/** Paid tier: cheap-model classification. Fails open to signal on bad output. */
export async function modelTriage(
  deps: WorkerDeps,
  channelName: string,
  messages: SlackMsg[],
  sourceKey: string,
): Promise<TriageDecision> {
  if (!deps.llm) {
    // No model configured: pass through, keep collecting (fail open).
    return { verdict: "signal", score: 0.5, method: "fallback-no-llm", tags: {} };
  }

  const thread = (await formatSlackMessagesForLlm(deps, messages)).slice(0, 6000);

  const response = await deps.llm.invoke("triage", {
    system: CLASSIFIER_SYSTEM,
    messages: [{ role: "user", content: [{ text: `Channel: #${channelName}\n\n${thread}` }] }],
    maxTokens: 300,
    temperature: 0,
    purpose: sourceKey,
  });

  const match = response.text.match(/\{[\s\S]*\}/);
  if (!match) {
    deps.logger.warn({ sourceKey, text: response.text.slice(0, 200) }, "triage output unparseable");
    return { verdict: "signal", score: 0.5, method: "fallback-bad-output", tags: {} };
  }
  try {
    const parsed = JSON.parse(match[0]) as {
      signal?: boolean;
      confidence?: number;
      event_types?: string[];
      topics?: string[];
    };
    const confidence =
      typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0.5;
    // Normalize to P(signal) regardless of which verdict the model asserted.
    const score = parsed.signal === false ? 1 - confidence : confidence;
    return {
      verdict: "signal", // final verdict is thresholded by the caller
      score,
      method: "model",
      tags: { eventTypes: parsed.event_types ?? [], topics: parsed.topics ?? [] },
    };
  } catch {
    return { verdict: "signal", score: 0.5, method: "fallback-bad-output", tags: {} };
  }
}

/** Full triage for one raw artifact; records the decision and returns it. */
export async function triageArtifact(
  deps: WorkerDeps,
  artifactId: string,
  sourceKey: string,
  envelope: RawEnvelope,
): Promise<TriageDecision> {
  const threshold = triageThreshold();
  let decision: TriageDecision;

  if (envelope.source === "slack") {
    const payload = envelope.payload as { channelId?: string; messages?: SlackMsg[] };
    const messages = payload.messages ?? [];
    const channelName =
      ((envelope.sourceMeta as { channelName?: string }).channelName ?? payload.channelId) ?? "";
    decision =
      heuristicTriage(messages) ?? (await modelTriage(deps, channelName, messages, sourceKey));
  } else {
    // Non-Slack LLM-path sources (future GWS surfaces) pass through for now.
    decision = { verdict: "signal", score: 0.5, method: "passthrough", tags: {} };
  }

  // Model scores are thresholded; heuristics carry their own verdict.
  if (decision.method === "model") {
    decision.verdict = decision.score >= threshold ? "signal" : "noise";
  }

  await deps.db.insert(tables.triageDecisions).values({
    artifactId,
    sourceKey,
    verdict: decision.verdict,
    score: decision.score,
    threshold,
    method: decision.method,
    tags: decision.tags,
  });
  emitMetric(decision.verdict, 1, { stage: "triage", source: envelope.source });

  return decision;
}

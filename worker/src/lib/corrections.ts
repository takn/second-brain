/**
 * Rejection feedback loop (task 4.7, brain-agents spec): rejection records
 * (item, reason, source) become few-shot correction context in extractor and
 * synthesizer prompts, so a POC rejecting a mistake teaches the agents not to
 * repeat it.
 *
 * Both helpers return a ready-to-append prompt block, or "" when there is
 * nothing to learn from — callers just concatenate.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { tables } from "@second-brain/schema";
import type { WorkerDeps } from "./deps.ts";

const LOOKBACK_DAYS = Number(process.env.CORRECTIONS_LOOKBACK_DAYS ?? 90);
const MAX_EXAMPLES = Number(process.env.CORRECTIONS_MAX_EXAMPLES ?? 8);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Correction examples for the Extractor: recent event rejections, most similar
 * sources first (same connector — a Slack-extraction mistake is most
 * instructive for the next Slack artifact), then by recency.
 */
export async function extractionCorrections(
  deps: Pick<WorkerDeps, "db">,
  source: string,
): Promise<string> {
  const rows = await deps.db
    .select({
      reason: tables.rejections.reason,
      snapshot: tables.rejections.snapshot,
      createdAt: tables.rejections.createdAt,
      source: tables.rawArtifacts.source,
    })
    .from(tables.rejections)
    .innerJoin(tables.events, eq(tables.events.id, tables.rejections.targetId))
    .innerJoin(tables.rawArtifacts, eq(tables.rawArtifacts.id, tables.events.artifactId))
    .where(
      and(
        eq(tables.rejections.targetKind, "event"),
        gte(tables.rejections.createdAt, new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)),
      ),
    )
    .orderBy(desc(tables.rejections.createdAt))
    .limit(MAX_EXAMPLES * 3);
  if (rows.length === 0) return "";

  const ranked = [...rows].sort((a, b) => {
    const sa = a.source === source ? 0 : 1;
    const sb = b.source === source ? 0 : 1;
    return sa !== sb ? sa - sb : b.createdAt.getTime() - a.createdAt.getTime();
  });

  const lines = ranked.slice(0, MAX_EXAMPLES).map((r) => {
    const snap = r.snapshot as { type?: string; title?: string };
    return `- [${snap.type ?? "event"}] "${clip(snap.title ?? "(unknown)", 140)}" (from ${r.source}) — rejected: ${clip(r.reason, 200)}`;
  });

  return `

Previously rejected extractions — correction examples. A human rejected these as wrong; do not repeat these mistakes on similar content:
${lines.join("\n")}`;
}

/**
 * Correction examples for the Synthesizer: rejections scoped to the project
 * being synthesized — rejected events must not have their claims reintroduced,
 * and rejected narrative revisions explain what a human found wrong with a
 * previous write-up.
 */
export async function synthesisCorrections(
  deps: Pick<WorkerDeps, "db">,
  projectId: string,
): Promise<string> {
  const rows = await deps.db
    .select({
      targetKind: tables.rejections.targetKind,
      reason: tables.rejections.reason,
      snapshot: tables.rejections.snapshot,
    })
    .from(tables.rejections)
    .where(
      and(
        eq(tables.rejections.projectId, projectId),
        gte(tables.rejections.createdAt, new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)),
      ),
    )
    .orderBy(desc(tables.rejections.createdAt))
    .limit(MAX_EXAMPLES);
  if (rows.length === 0) return "";

  const lines = rows.map((r) => {
    if (r.targetKind === "event") {
      const snap = r.snapshot as { type?: string; title?: string };
      return `- rejected event [${snap.type ?? "event"}] "${clip(snap.title ?? "(unknown)", 140)}" — reason: ${clip(r.reason, 200)}`;
    }
    if (r.targetKind === "narrative_revision") {
      const snap = r.snapshot as { revision?: number; summary?: string | null; body?: string };
      const gist = snap.summary ?? (snap.body ? clip(snap.body, 160) : "(no summary)");
      return `- rejected narrative revision${snap.revision ? ` r${snap.revision}` : ""} ("${clip(gist, 160)}") — reason: ${clip(r.reason, 200)}`;
    }
    return `- rejected ${r.targetKind} — reason: ${clip(r.reason, 200)}`;
  });

  return `

Human rejections on this project — correction context. Do not reintroduce rejected claims, and avoid whatever the rejection reasons describe:
${lines.join("\n")}`;
}

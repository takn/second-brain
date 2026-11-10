/**
 * CloudWatch Embedded Metric Format (EMF): structured lines on stdout that
 * CloudWatch Logs turns into metrics automatically. No API calls, no cost
 * locally — they're just log lines.
 */

const FUNNEL_NAMESPACE = "second-brain/funnel";

type Unit = "Count" | "Milliseconds" | "None";

/**
 * Emit one EMF record. `dimensionSets` controls aggregation: e.g.
 * [["agent"], []] publishes each metric both per-agent and as an
 * all-agents aggregate (the aggregate is what alarms watch).
 */
export function emitEmf(input: {
  namespace: string;
  dimensions: Record<string, string>;
  dimensionSets?: string[][];
  metrics: Array<{ name: string; value: number; unit?: Unit }>;
}): void {
  process.stdout.write(
    `${JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: input.namespace,
            Dimensions: input.dimensionSets ?? [Object.keys(input.dimensions)],
            Metrics: input.metrics.map((m) => ({ Name: m.name, Unit: m.unit ?? "Count" })),
          },
        ],
      },
      ...input.dimensions,
      ...Object.fromEntries(input.metrics.map((m) => [m.name, m.value])),
    })}\n`,
  );
}

export interface MetricDimensions {
  stage: string;
  source?: string;
}

export function emitMetric(
  name: string,
  value: number,
  dimensions: MetricDimensions,
  unit: Unit = "Count",
): void {
  const dims: Record<string, string> = { stage: dimensions.stage };
  if (dimensions.source) dims.source = dimensions.source;
  // Publish per-(stage[,source]) and as an undimensioned aggregate so alarms
  // can watch account-wide "failed" / "executor_refused" without knowing stage.
  const dimensionSets: string[][] = dimensions.source
    ? [["stage", "source"], ["stage"], []]
    : [["stage"], []];
  emitEmf({
    namespace: FUNNEL_NAMESPACE,
    dimensions: dims,
    dimensionSets,
    metrics: [{ name, value, unit }],
  });
}

/** Standard per-stage counters: processed / failed / lag from enqueue to handling. */
export function recordStageResult(input: {
  stage: string;
  source?: string;
  ok: boolean;
  enqueuedAt?: string;
}): void {
  const dims = { stage: input.stage, source: input.source };
  emitMetric(input.ok ? "processed" : "failed", 1, dims);
  if (input.enqueuedAt) {
    const lag = Date.now() - Date.parse(input.enqueuedAt);
    if (Number.isFinite(lag) && lag >= 0) emitMetric("lag", lag, dims, "Milliseconds");
  }
}

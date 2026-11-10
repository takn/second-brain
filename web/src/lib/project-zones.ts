/**
 * Situation-bar upstream sentence and lint grouping.
 * Exact string match only — near-duplicate details stay separate.
 */

export function upstreamSentence(
  findings: { detail: string | null }[],
  dependencies: { direction: string; summary: string }[],
): string | null {
  const dependsOn = dependencies
    .filter((d) => d.direction === "depends_on")
    .map((d) => d.summary.trim())
    .filter((summary) => summary.length > 0);

  const details = findings.map((f) => f.detail?.trim() ?? "");
  const unique = [...new Set(details.filter(Boolean))];
  const shared = unique[0];
  const everyFindingShares =
    findings.length > 0 && shared !== undefined && unique.length === 1 && details.every((d) => d === shared);
  if (everyFindingShares && dependsOn.includes(shared)) return shared;
  return dependsOn[0] ?? null;
}

export function groupLintFindings<T extends { detail: string | null }>(
  findings: T[],
  hiddenDetail: string | null,
): { detail: string | null; items: T[] }[] {
  const groups: { key: string; detail: string | null; items: T[] }[] = [];
  for (const finding of findings) {
    const trimmed = finding.detail?.trim() || null;
    const key = trimmed ?? "";
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = {
        key,
        detail: trimmed && trimmed === hiddenDetail ? null : trimmed,
        items: [],
      };
      groups.push(group);
    }
    group.items.push(finding);
  }
  return groups.map(({ detail, items }) => ({ detail, items }));
}

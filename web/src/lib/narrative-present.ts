/**
 * Presentation pass over an existing status narrative. Does not call a model.
 * Progress shows through the first remaining heading section; the full body
 * is the same text with the title/status echo removed and lists uncapped.
 */

export const NARRATIVE_LIST_CAP = 5;

const HEADING = /^#{1,6}\s+\S/;
const TOP_LEVEL_ITEM = /^([-*+]|\d+\.)\s+/;
const EVENT_MARKER = /\[event:([0-9a-fA-F-]{36})\]/g;

export type NarrativeChunk =
  | { kind: "markdown"; text: string }
  | { kind: "capped-list"; visible: string; hidden: string; hiddenCount: number };

export type PreparedNarrative = {
  full: string;
  excerpt: NarrativeChunk[];
};

function lineAt(lines: readonly string[], index: number): string {
  return lines[index] ?? "";
}

function plain(text: string): string {
  return text.replace(/[*_`]/g, "").trim().toLowerCase();
}

function isHeading(line: string): boolean {
  return HEADING.test(line);
}

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s+\S/.exec(line);
  return match?.[1]?.length ?? 0;
}

function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

function isEchoHeading(text: string, projectName: string): boolean {
  const heading = plain(text);
  const name = plain(projectName);
  if (!heading) return false;
  if (name && heading === name) return true;
  return (
    heading.endsWith("status narrative") ||
    heading.endsWith("project status") ||
    heading.endsWith("status update") ||
    heading.endsWith("project status update") ||
    heading.endsWith("— status") ||
    heading.endsWith("- status")
  );
}

function isStatusEcho(line: string): boolean {
  return /^(overall\s+)?status\s*:/i.test(plain(line));
}

/** Markdown thematic break: ---, ***, ___ (3+ markers, spaces allowed). */
function isHorizontalRule(line: string): boolean {
  const compact = line.trim().replace(/\s+/g, "");
  return /^(-{3,}|\*{3,}|_{3,})$/.test(compact);
}

function isTopLevelListItem(line: string): boolean {
  return TOP_LEVEL_ITEM.test(line);
}

function isContinuation(line: string): boolean {
  return /^\s+\S/.test(line);
}

/**
 * Drop the leading title heading plus any mix of overall-status lines and
 * horizontal rules that echo it (the synthesizer tends to open with
 * `# Name — Status`, `**Overall status:** …`, `---`).
 */
export function trimNarrativeEcho(body: string, projectName: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lineAt(lines, i).trim() === "") i++;
  if (i < lines.length && isHeading(lineAt(lines, i)) && isEchoHeading(headingText(lineAt(lines, i)), projectName)) {
    i++;
  }
  for (;;) {
    while (i < lines.length && lineAt(lines, i).trim() === "") i++;
    if (i < lines.length && (isStatusEcho(lineAt(lines, i)) || isHorizontalRule(lineAt(lines, i)))) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n").trim();
}

/** Preamble plus the first heading section. The whole body if fewer than two headings. */
export function excerptThroughFirstSection(markdown: string): string {
  if (!markdown) return "";
  const lines = markdown.split("\n");
  const headings: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lineAt(lines, i))) headings.push(i);
  }
  if (headings.length < 2) return markdown;
  const cut = headings[1];
  if (cut === undefined) return markdown;
  return lines.slice(0, cut).join("\n").trim();
}

function pushItemLine(items: string[][], line: string) {
  const current = items[items.length - 1];
  if (current) current.push(line);
}

function consumeList(lines: string[], start: number): { items: string[][]; next: number } {
  const items: string[][] = [];
  let i = start;
  if (!isTopLevelListItem(lineAt(lines, start))) return { items, next: start };

  while (i < lines.length) {
    const line = lineAt(lines, i);
    if (line.trim() === "") {
      let j = i + 1;
      while (j < lines.length && lineAt(lines, j).trim() === "") j++;
      const next = lines[j];
      if (items.length > 0 && next !== undefined && (isTopLevelListItem(next) || isContinuation(next))) {
        pushItemLine(items, line);
        i++;
        continue;
      }
      break;
    }
    if (isTopLevelListItem(line)) {
      items.push([line]);
      i++;
      continue;
    }
    if (items.length > 0 && isContinuation(line)) {
      pushItemLine(items, line);
      i++;
      continue;
    }
    break;
  }
  return { items, next: i };
}

export function capLists(markdown: string, cap = NARRATIVE_LIST_CAP): NarrativeChunk[] {
  if (!markdown.trim()) return [];
  const lines = markdown.split("\n");
  const chunks: NarrativeChunk[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").replace(/^\n+|\n+$/g, "");
    if (text.trim()) chunks.push({ kind: "markdown", text });
    buffer = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (isTopLevelListItem(lineAt(lines, i))) {
      flush();
      const parsed = consumeList(lines, i);
      if (parsed.items.length > cap) {
        chunks.push({
          kind: "capped-list",
          visible: parsed.items.slice(0, cap).map((item) => item.join("\n")).join("\n").trim(),
          hidden: parsed.items.slice(cap).map((item) => item.join("\n")).join("\n").trim(),
          hiddenCount: parsed.items.length - cap,
        });
      } else {
        const text = lines.slice(i, parsed.next).join("\n").trim();
        if (text) chunks.push({ kind: "markdown", text });
      }
      i = parsed.next;
      continue;
    }
    buffer.push(lineAt(lines, i));
    i++;
  }
  flush();
  return chunks;
}

export function prepareNarrative(body: string, projectName: string): PreparedNarrative {
  const full = trimNarrativeEcho(body, projectName);
  return { full, excerpt: capLists(excerptThroughFirstSection(full)) };
}

export type NarrativeSection = { title: string; body: string };

/** Remove horizontal rules hugging the edges of a section body. */
function stripEdgeRules(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && (lineAt(lines, start).trim() === "" || isHorizontalRule(lineAt(lines, start)))) start++;
  while (end > start && (lineAt(lines, end - 1).trim() === "" || isHorizontalRule(lineAt(lines, end - 1)))) end--;
  return lines.slice(start, end).join("\n").trim();
}

/**
 * Split a trimmed narrative into heading sections for collapsible UI.
 * Only the shallowest heading level in the doc becomes a section boundary
 * (so `###` under `##` stays inside the parent). Leading prose before the
 * first section heading becomes "Overview". A body with no headings is a
 * single "Narrative" section. Empty section bodies are omitted.
 */
export function splitNarrativeSections(markdown: string): NarrativeSection[] {
  if (!markdown.trim()) return [];
  const lines = markdown.split("\n");
  const headingIndexes: number[] = [];
  let topLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const level = headingLevel(lineAt(lines, i));
    if (level === 0) continue;
    if (topLevel === 0 || level < topLevel) topLevel = level;
    headingIndexes.push(i);
  }

  if (headingIndexes.length === 0 || topLevel === 0) {
    return [{ title: "Narrative", body: markdown.trim() }];
  }

  const sectionStarts = headingIndexes.filter((i) => headingLevel(lineAt(lines, i)) === topLevel);
  if (sectionStarts.length === 0) {
    return [{ title: "Narrative", body: markdown.trim() }];
  }

  const sections: NarrativeSection[] = [];
  const firstHeading = sectionStarts[0]!;
  if (firstHeading > 0) {
    const preamble = stripEdgeRules(lines.slice(0, firstHeading).join("\n"));
    if (preamble) sections.push({ title: "Overview", body: preamble });
  }

  for (let s = 0; s < sectionStarts.length; s++) {
    const start = sectionStarts[s]!;
    const end = sectionStarts[s + 1] ?? lines.length;
    const title = headingText(lineAt(lines, start));
    const body = stripEdgeRules(lines.slice(start + 1, end).join("\n"));
    if (!body) continue;
    sections.push({ title, body });
  }
  return sections.length > 0 ? sections : [{ title: "Narrative", body: markdown.trim() }];
}

/** Rewrite [event:<uuid>] markers into numbered #evt- links. Mutates `order`. */
export function linkCitations(text: string, order: string[]): string {
  return text.replace(new RegExp(EVENT_MARKER.source, "g"), (_match, id: string) => {
    let n = order.indexOf(id);
    if (n === -1) {
      order.push(id);
      n = order.length - 1;
    }
    return `[[${n + 1}]](#evt-${id})`;
  });
}

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  linkCitations,
  prepareNarrative,
  splitNarrativeSections,
  type NarrativeChunk,
} from "./narrative-present";

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function markdownOf(chunks: NarrativeChunk[]): string {
  return chunks
    .map((chunk) => (chunk.kind === "markdown" ? chunk.text : `${chunk.visible}\n${chunk.hidden}`))
    .join("\n");
}

describe("prepareNarrative", () => {
  it("strips a leading status-narrative heading and the overall-status line", () => {
    const body = [
      "# At-Scale Services — Project Status Narrative",
      "",
      "Overall status: On-track | Priority: P2",
      "",
      "Inference is shipping.",
      "",
      "## Recent completions",
      "",
      "- Shipped the tracker",
    ].join("\n");

    const prepared = prepareNarrative(body, "At-Scale Services");
    expect(prepared.full.startsWith("Inference is shipping.")).toBe(true);
    expect(prepared.full).not.toMatch(/status narrative/i);
    expect(prepared.full).not.toMatch(/overall status/i);
    expect(markdownOf(prepared.excerpt)).toContain("Inference is shipping.");
    expect(markdownOf(prepared.excerpt)).toContain("Shipped the tracker");
  });

  it("strips a heading that is only the project title", () => {
    const prepared = prepareNarrative("# At-Scale Services\n\nStill on track.", "At-Scale Services");
    expect(prepared.full).toBe("Still on track.");
  });

  it("strips the bold status echo and trailing horizontal rule (production shape)", () => {
    // Matches what the synthesizer actually emits for most projects.
    const body = [
      "# Second Brain Interfaces — Project Status Narrative",
      "**Overall status:** On-track | **Priority:** P2",
      "---",
      "## Recent Releases & Merges",
      "- MR !48 synced pyproject to v0.6.0",
    ].join("\n");

    const prepared = prepareNarrative(body, "Second Brain Interfaces");
    expect(prepared.full.startsWith("## Recent Releases & Merges")).toBe(true);
  });

  it("strips 'Project Status' headings and plain **Status:** echoes", () => {
    const body = [
      "# Cloud Administration — Project Status",
      "**Status:** On-Track | **Priority:** P2",
      "---",
      "## Current Focus",
      "Prioritizing three agent frameworks.",
    ].join("\n");

    const prepared = prepareNarrative(body, "Cloud Administration");
    expect(prepared.full.startsWith("## Current Focus")).toBe(true);
  });

  it("caps a list longer than five and counts the rest", () => {
    const items = Array.from({ length: 7 }, (_, i) => `- item ${i + 1}`);
    const body = ["Intro.", "", "## Recent completions", "", ...items, "", "## Risks", "", "- later"].join("\n");
    const prepared = prepareNarrative(body, "At-Scale Services");
    const capped = prepared.excerpt.find((chunk) => chunk.kind === "capped-list");
    expect(capped).toMatchObject({ hiddenCount: 2 });
    if (capped?.kind === "capped-list") {
      expect(capped.visible).toContain("- item 1");
      expect(capped.visible).toContain("- item 5");
      expect(capped.visible).not.toContain("- item 6");
      expect(capped.hidden).toContain("- item 6");
      expect(capped.hidden).toContain("- item 7");
    }
    expect(markdownOf(prepared.excerpt)).not.toContain("later");
    expect(prepared.full).toContain("- item 7");
    expect(prepared.full).toContain("- later");
  });

  it("returns the whole body as the excerpt when there are no headings", () => {
    const body = ["No headings here.", "", `- cited [event:${ID}]`].join("\n");
    const prepared = prepareNarrative(body, "At-Scale Services");
    expect(prepared.full).toBe(body);
    expect(markdownOf(prepared.excerpt)).toContain("No headings here.");
    expect(markdownOf(prepared.excerpt)).toContain(`[event:${ID}]`);
  });

  it("leaves citation markers intact", () => {
    const body = `Claim [event:${ID}].\n\n## Next\n\n- more`;
    const prepared = prepareNarrative(body, "At-Scale Services");
    expect(prepared.full).toContain(`[event:${ID}]`);
    expect(markdownOf(prepared.excerpt)).toContain(`[event:${ID}]`);
  });
});

describe("linkCitations", () => {
  it("turns an event marker into a timeline anchor", () => {
    const order: string[] = [];
    expect(linkCitations(`see [event:${ID}]`, order)).toBe(`see [[1]](#evt-${ID})`);
    expect(order).toEqual([ID]);
  });
});

describe("splitNarrativeSections", () => {
  it("splits on headings and keeps a preamble as Overview", () => {
    const body = [
      "Inference is shipping.",
      "",
      "## Recent completions",
      "",
      "- Shipped the tracker",
      "",
      "## Risks",
      "",
      "- Latency budget",
    ].join("\n");
    expect(splitNarrativeSections(body)).toEqual([
      { title: "Overview", body: "Inference is shipping." },
      { title: "Recent completions", body: "- Shipped the tracker" },
      { title: "Risks", body: "- Latency budget" },
    ]);
  });

  it("keeps deeper headings inside the parent section", () => {
    const body = [
      "## Overview",
      "",
      "Still on track.",
      "",
      "### Detail",
      "",
      "- Nested bullet",
      "",
      "## Risks",
      "",
      "- Latency",
    ].join("\n");
    expect(splitNarrativeSections(body)).toEqual([
      {
        title: "Overview",
        body: ["Still on track.", "", "### Detail", "", "- Nested bullet"].join("\n"),
      },
      { title: "Risks", body: "- Latency" },
    ]);
  });

  it("omits empty top-level sections", () => {
    const body = ["## Empty", "", "## Risks", "", "- Latency"].join("\n");
    expect(splitNarrativeSections(body)).toEqual([{ title: "Risks", body: "- Latency" }]);
  });

  it("uses a single Narrative section when there are no headings", () => {
    expect(splitNarrativeSections("Just a paragraph.")).toEqual([
      { title: "Narrative", body: "Just a paragraph." },
    ]);
  });

  it("never emits an Overview made only of horizontal rules", () => {
    const body = ["---", "## Active Work", "Integration discussions underway.", "---", "## Risks", "- None"].join("\n");
    expect(splitNarrativeSections(body)).toEqual([
      { title: "Active Work", body: "Integration discussions underway." },
      { title: "Risks", body: "- None" },
    ]);
  });

  it("keeps real preamble prose while dropping the rules around it", () => {
    const body = ["---", "Inference is shipping.", "---", "## Risks", "- Latency"].join("\n");
    expect(splitNarrativeSections(body)).toEqual([
      { title: "Overview", body: "Inference is shipping." },
      { title: "Risks", body: "- Latency" },
    ]);
  });
});

describe("project page layout", () => {
  it("puts narrative above tabs and keeps event anchors outside collapsed details", () => {
    const pagePath = join(dirname(fileURLToPath(import.meta.url)), "../app/projects/[slug]/page.tsx");
    const src = readFileSync(pagePath, "utf8");
    expect(src).toContain('variant="sections"');
    expect(src).toContain("ProjectTabs");
    expect(src).toContain("health:");
    const narrativeAt = src.indexOf('className="project-narrative"');
    const tabsAt = src.indexOf("<ProjectTabs");
    expect(narrativeAt).toBeGreaterThan(-1);
    expect(tabsAt).toBeGreaterThan(narrativeAt);
  });
});

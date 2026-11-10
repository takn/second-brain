import { describe, expect, it } from "vitest";
import { groupLintFindings, upstreamSentence } from "./project-zones";

const shared = "This project depends on Infrastructure Services, which has an active blocker.";

describe("upstreamSentence", () => {
  it("uses the shared lint detail when it matches a depends-on summary", () => {
    expect(
      upstreamSentence(
        [
          { detail: shared },
          { detail: shared },
        ],
        [
          { direction: "depends_on", summary: "unrelated first dependency" },
          { direction: "depends_on", summary: shared },
        ],
      ),
    ).toBe(shared);
  });

  it("falls back to the first depends-on summary", () => {
    expect(
      upstreamSentence(
        [{ detail: "different finding" }],
        [
          { direction: "depended_on_by", summary: "ignore reverse" },
          { direction: "depends_on", summary: "  DNS is waiting.  " },
        ],
      ),
    ).toBe("DNS is waiting.");
  });
});

describe("groupLintFindings", () => {
  it("shows one copy of a shared detail and hides the sentence already in the bar", () => {
    const groups = groupLintFindings(
      [
        { id: "a", detail: shared },
        { id: "b", detail: shared },
        { id: "c", detail: "A different finding." },
      ],
      shared,
    );
    expect(groups).toEqual([
      { detail: null, items: [{ id: "a", detail: shared }, { id: "b", detail: shared }] },
      { detail: "A different finding.", items: [{ id: "c", detail: "A different finding." }] },
    ]);
  });
});

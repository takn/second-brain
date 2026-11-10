import { describe, expect, it } from "vitest";
import { EVENT_TYPES, jobSchema } from "./index.ts";

describe("event taxonomy", () => {
  it("contains the eight core event types", () => {
    expect(EVENT_TYPES).toHaveLength(8);
    expect(EVENT_TYPES).toContain("decision");
    expect(EVENT_TYPES).toContain("blocker_raised");
  });
});

describe("job envelope", () => {
  it("accepts a valid job", () => {
    const job = jobSchema.parse({
      kind: "triage",
      source: "slack",
      sourceKey: "C123:1725000000.000100",
      payload: {},
      enqueuedAt: new Date().toISOString(),
    });
    expect(job.kind).toBe("triage");
  });

  it("rejects an unknown job kind", () => {
    expect(() =>
      jobSchema.parse({ kind: "nonsense", enqueuedAt: new Date().toISOString() }),
    ).toThrow();
  });
});

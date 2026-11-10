import { describe, expect, it } from "vitest";
import { deriveConnectorHealth, STALE_AFTER_MS } from "./connector-health";

const now = new Date("2026-09-08T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("deriveConnectorHealth", () => {
  it("returns never synced when there are no runs", () => {
    expect(deriveConnectorHealth(undefined, now)).toBe("never synced");
  });

  it("returns failing when the latest run failed, regardless of recency", () => {
    expect(deriveConnectorHealth({ status: "failed", startedAt: minutesAgo(1) }, now)).toBe(
      "failing",
    );
    expect(deriveConnectorHealth({ status: "failed", startedAt: minutesAgo(600) }, now)).toBe(
      "failing",
    );
  });

  it("returns stale when the latest run succeeded but is older than the threshold", () => {
    const justOver = new Date(now.getTime() - STALE_AFTER_MS - 1);
    expect(deriveConnectorHealth({ status: "ok", startedAt: justOver }, now)).toBe("stale");
  });

  it("returns healthy when the latest run succeeded within the threshold", () => {
    expect(deriveConnectorHealth({ status: "ok", startedAt: minutesAgo(59) }, now)).toBe("healthy");
    const exactlyAt = new Date(now.getTime() - STALE_AFTER_MS);
    expect(deriveConnectorHealth({ status: "ok", startedAt: exactlyAt }, now)).toBe("healthy");
  });
});

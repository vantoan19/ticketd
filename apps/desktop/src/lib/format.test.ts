import { describe, expect, it } from "vitest";
import { compactAgo } from "./format";

describe("compactAgo", () => {
  const now = Date.parse("2026-01-15T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  it("reads the shortest age", () => {
    expect(compactAgo(at(10_000), now)).toBe("now");
    expect(compactAgo(at(2 * 60_000), now)).toBe("2m");
    expect(compactAgo(at(6 * 60_000), now)).toBe("6m");
    expect(compactAgo(at(3_600_000), now)).toBe("1h");
    expect(compactAgo(at(2 * 3_600_000), now)).toBe("2h");
    expect(compactAgo(at(86_400_000), now)).toBe("1d");
    expect(compactAgo(at(14 * 86_400_000), now)).toBe("2w");
    expect(compactAgo("nope", now)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { compactAgo, listTime, ofTotal, plural } from "./format";

describe("compactAgo", () => {
  const now = Date.parse("2026-01-15T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  it("reads the shortest age, then a short date after a week", () => {
    expect(compactAgo(at(10_000), now)).toBe("now");
    expect(compactAgo(at(2 * 60_000), now)).toBe("2m");
    expect(compactAgo(at(6 * 60_000), now)).toBe("6m");
    expect(compactAgo(at(3_600_000), now)).toBe("1h");
    expect(compactAgo(at(2 * 3_600_000), now)).toBe("2h");
    expect(compactAgo(at(86_400_000), now)).toBe("1d");
    expect(compactAgo(at(14 * 86_400_000), now)).toMatch(/Jan|1/);
    expect(compactAgo(at(14 * 86_400_000), now)).not.toMatch(/w$/);
    expect(compactAgo("nope", now)).toBeNull();
  });
});

describe("counts", () => {
  it("writes one plural and one filtered-of-total form", () => {
    expect(plural(1, "comment")).toBe("1 comment");
    expect(plural(3, "comment")).toBe("3 comments");
    expect(plural(2, "match", "matches")).toBe("2 matches");
    expect(ofTotal(3, 12)).toBe("3 of 12");
  });
});

describe("listTime", () => {
  // Wednesday 25 Nov 2026, 23:50 local time.
  const now = new Date(2026, 10, 25, 23, 50).getTime();
  const at = (...parts: [number, number, number, number?, number?]) =>
    new Date(...parts).toISOString();
  const read = (timestamp: string) => listTime(timestamp, now, "en-GB");
  it("tells a time of day today, a weekday this week, a date this year, then the full date", () => {
    expect(read(at(2026, 10, 25, 23, 43))).toBe("23:43");
    expect(read(at(2026, 10, 25, 14, 5))).toBe("14:05");
    expect(read(at(2026, 10, 24, 23, 59))).toBe("Tue");
    expect(read(at(2026, 10, 19, 0, 0))).toBe("Thu");
    expect(read(at(2026, 10, 18, 12, 0))).toBe("18 Nov");
    expect(read(at(2026, 0, 3, 9, 0))).toBe("3 Jan");
    expect(read(at(2025, 10, 25, 9, 0))).toBe("25 Nov 2025");
  });
  it("returns null for a value that is not a date", () => {
    expect(read("nope")).toBeNull();
  });
});

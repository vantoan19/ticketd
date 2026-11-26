import { expect, test } from "vitest";
import { formatProgress } from "./format-size";

test("progress is both numbers in the total's unit, with whole bytes", () => {
  expect(formatProgress(1.2 * 1024 * 1024, 3.4 * 1024 * 1024)).toBe(
    "1.2 of 3.4 MB",
  );
  expect(formatProgress(34.74, 193)).toBe("35 of 193 B");
  expect(formatProgress(0, 1700)).toBe("0 of 1.7 KB");
  expect(formatProgress(5 * 1024 * 1024, 4 * 1024 * 1024)).toBe("4 of 4 MB");
});

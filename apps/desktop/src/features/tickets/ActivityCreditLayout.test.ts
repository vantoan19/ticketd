import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

test("an Activity row's credit chip gives way with an ellipsis, so it never sits under the time or Latest", () => {
  // Every part of the author line keeps its width but the chip (T-UB282, F-A5).
  const css = readFileSync(join(__dirname, "activity.css"), "utf8");
  expect(css).toMatch(/\.activity-author > \* \{\s*flex: none/);
  expect(css).toMatch(
    /\.activity-author > \.activity-subagent \{\s*flex: 0 1 auto/,
  );
  expect(css).toMatch(
    /\.activity-subagent > span \{[^}]*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap/,
  );
});

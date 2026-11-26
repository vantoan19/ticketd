import { expect, it } from "vitest";
import { foldAllIntros, foldAllTargets, hiddenBy } from "./folding";
import { outlineOf } from "./outline";

const headings = outlineOf(
  "## A\n\n### A1\n\n### A2\n\n## B\n\n## C\n\n### C1\n\n#### Deep",
);

it("folds the sections that hold no subsection, so every heading stays on show", () => {
  expect(foldAllTargets(headings)).toEqual(["a1", "a2", "b", "c1"]);
});

it("folds the sections that hold subsections to their first sentence only", () => {
  expect(foldAllIntros(headings)).toEqual(["a", "c"]);
});

it("names the folded sections that hide a heading, nearest first", () => {
  const folded = new Set(["a", "c", "c1"]);
  expect(hiddenBy(headings, "deep", folded)).toEqual(["c1", "c"]);
  expect(hiddenBy(headings, "a2", folded)).toEqual(["a"]);
  expect(hiddenBy(headings, "b", folded)).toEqual([]);
  expect(hiddenBy(headings, "c", folded)).toEqual(["c"]);
});

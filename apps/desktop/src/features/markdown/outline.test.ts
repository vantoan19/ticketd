import { expect, it } from "vitest";
import { currentHeading, outlineOf, showsOutline } from "./outline";

it("lists h1 to h4 in order with levels, text and unique anchors", () => {
  const headings = outlineOf(
    [
      "Intro",
      "",
      "## Goals",
      "",
      "### `Code` and **bold**",
      "",
      "## Goals",
      "",
      "##### Too deep",
      "",
      "# Top",
    ].join("\n"),
  );
  expect(headings.map((h) => [h.level, h.text, h.id])).toEqual([
    [2, "Goals", "goals"],
    [3, "Code and bold", "code-and-bold"],
    [2, "Goals", "goals-1"],
    [1, "Top", "top"],
  ]);
});

it("ignores heading-looking lines inside code fences", () => {
  expect(outlineOf("```\n## Not a heading\n```\n\n## Real")).toHaveLength(1);
});

it("gives a heading without letters an anchor anyway", () => {
  expect(outlineOf("## ***")[0]?.id).toBe("section");
});

it("marks sections and subsections by depth", () => {
  const headings = outlineOf("## A\n\n### B\n\n#### C\n\n# D");
  expect(headings.map((h) => h.section)).toEqual([true, false, false, true]);
});

it("shows an outline from three headings", () => {
  expect(showsOutline(outlineOf("## A\n\n## B"))).toBe(false);
  expect(showsOutline(outlineOf("## A\n\n## B\n\n### C"))).toBe(true);
});

it("makes the last heading above the reading line current", () => {
  const offsets = [100, 400, 900];
  expect(currentHeading(offsets, 450)).toBe(1);
  expect(currentHeading(offsets, 400)).toBe(1);
  expect(currentHeading(offsets, 5000)).toBe(2);
});

it("makes the first heading current above all of them, and none when there are none", () => {
  expect(currentHeading([100, 400], 20)).toBe(0);
  expect(currentHeading([], 20)).toBeNull();
});

it("marks h2 and h3 blocks as foldable, and nothing nested in a quote or list", () => {
  const headings = outlineOf(
    "# Top\n\n## A\n\n### B\n\n#### C\n\n> ## Quoted\n\n- ### Listed",
  );
  expect(headings.map((h) => [h.text, h.foldable])).toEqual([
    ["Top", false],
    ["A", true],
    ["B", true],
    ["C", false],
    ["Quoted", false],
    ["Listed", false],
  ]);
});

it("takes the first sentence under a heading as its summary", () => {
  const headings = outlineOf(
    [
      "## Plain",
      "",
      "It works.  It is *fast* and `small`. More.",
      "",
      "## No full stop",
      "",
      "Just a line",
      "",
      "## Code first",
      "",
      "```",
      "ignored. text",
      "```",
      "",
      "- Item one. Item two.",
      "",
      "## Empty",
      "",
      "### Next",
      "",
      "## Version",
      "",
      "Version 1.2 shipped. Done.",
    ].join("\n"),
  );
  expect(headings.map((h) => h.summary)).toEqual([
    "It works.",
    "Just a line",
    "Item one.",
    "",
    "",
    "Version 1.2 shipped.",
  ]);
});

import { expect, test } from "vitest";
import { CARD_HEIGHT, CARD_WIDTH, layoutContextGraph } from "./context-layout";

test("lays out cycles deterministically and preserves existing positions", () => {
  const input = {
    nodes: ["a", "b", "c"],
    edges: [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "c", target: "a" },
    ],
    positions: { a: { x: 12, y: 34 } },
  };
  const first = layoutContextGraph(input);
  expect(first.a).toEqual({ x: 12, y: 34 });
  expect(first).toEqual(layoutContextGraph(input));
  expect(Number.isFinite(first.c?.x)).toBe(true);
  expect(first.b).not.toEqual(first.c);
});

function overlaps(points: Record<string, { x: number; y: number }>) {
  const ids = Object.keys(points);
  const pairs: string[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = points[ids[i]!]!;
      const b = points[ids[j]!]!;
      if (Math.abs(a.x - b.x) < CARD_WIDTH && Math.abs(a.y - b.y) < CARD_HEIGHT)
        pairs.push(`${ids[i]}/${ids[j]}`);
    }
  return pairs;
}

test.each([14, 49])("no two cards overlap with %i neighbours", (count) => {
  const nodes = ["hub", ...Array.from({ length: count }, (_, i) => `n${i}`)];
  const points = layoutContextGraph({
    nodes,
    center: "hub",
    edges: nodes.slice(1).map((target) => ({ source: "hub", target })),
    positions: {},
  });
  expect(overlaps(points)).toEqual([]);
  expect(
    layoutContextGraph({ nodes, center: "hub", edges: [], positions: {} }).hub,
  ).toEqual(points.hub);
});

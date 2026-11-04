import { expect, test } from "vitest";
import { layoutContextGraph } from "./context-layout";

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

import { expect, test } from "vitest";
import type { DependencyGraph } from "@/lib/api/client";
import {
  NODE_HEIGHT,
  MAX_PER_ROW,
  NODE_WIDTH,
  boundsOf,
  fitViewport,
  layoutGraph,
  openViewport,
  scopeNotice,
} from "./dependency-graph-model";

const node = (reference: string) => ({
  id: reference,
  reference,
  title: `Title ${reference}`,
  status: "Todo",
  trashed: false,
  availability: null,
});
const graph: DependencyGraph = {
  nodes: [node("T-KQ1"), node("T-KQ2"), node("T-KQ3")],
  edges: [
    { blocker: "T-KQ1", dependent: "T-KQ2" },
    { blocker: "T-KQ2", dependent: "T-KQ3" },
  ],
  max_nodes: 50,
  max_depth: 5,
  max_edges: 300,
  max_work: 3000,
  omitted_neighbors: false,
  omitted_edges: false,
  truncated: false,
};

test("blockers are laid out above the tickets they block", () => {
  const positions = layoutGraph(graph);
  const y = (reference: string) => positions.get(reference)?.y ?? NaN;
  expect(y("T-KQ1")).toBeLessThan(y("T-KQ2"));
  expect(y("T-KQ2")).toBeLessThan(y("T-KQ3"));
});

test("only a limited graph states how far it reaches", () => {
  expect(scopeNotice(graph, "T-KQ2")).toBeNull();
  expect(scopeNotice({ ...graph, truncated: true }, "T-KQ2")).toContain(
    "up to 5 links from T-KQ2 and at most 50 tickets",
  );
});

const dense: DependencyGraph = {
  ...graph,
  nodes: Array.from({ length: 55 }, (_, index) => node(`T-KQ${index + 1}`)),
  edges: [
    ...Array.from({ length: 30 }, (_, index) => ({
      blocker: "T-KQ1",
      dependent: `T-KQ${index + 2}`,
    })),
    { blocker: "T-KQ2", dependent: "T-KQ20" },
    { blocker: "T-KQ20", dependent: "T-KQ21" },
  ],
};

test("a hub with very many dependents wraps into rows within a width budget", () => {
  const positions = layoutGraph(dense);
  const bounds = boundsOf(positions, positions.keys());
  expect(bounds!.width).toBeLessThanOrEqual(MAX_PER_ROW * (NODE_WIDTH + 32));
  expect(positions.get("T-KQ1")!.y).toBeLessThan(positions.get("T-KQ2")!.y);
  const spots = new Set([...positions.values()].map((at) => `${at.x},${at.y}`));
  expect(spots.size).toBe(dense.nodes.length);
});

test("Fit shows every ticket and the opening view keeps the hub in sight", () => {
  const positions = layoutGraph(dense);
  const size = { width: 900, height: 600 };
  const all = boundsOf(positions, positions.keys())!;
  const fit = fitViewport(all, size, { minZoom: 0.2, maxZoom: 1 });
  for (const at of positions.values()) {
    expect(at.x * fit.zoom + fit.x).toBeGreaterThanOrEqual(0);
    expect((at.x + NODE_WIDTH) * fit.zoom + fit.x).toBeLessThanOrEqual(900);
    expect(at.y * fit.zoom + fit.y).toBeGreaterThanOrEqual(0);
    expect((at.y + NODE_HEIGHT) * fit.zoom + fit.y).toBeLessThanOrEqual(600);
  }
  const open = openViewport(dense, positions, null, size, 0.7)!;
  expect(open.zoom).toBeGreaterThanOrEqual(0.7);
  const hub = positions.get("T-KQ1")!;
  const left = hub.x * open.zoom + open.x;
  expect(left).toBeGreaterThanOrEqual(0);
  expect(left + NODE_WIDTH * open.zoom).toBeLessThanOrEqual(900);
  expect(hub.y * open.zoom + open.y).toBeGreaterThanOrEqual(0);
});

test("a dense graph wraps wide ranks and opens readable on the selected ticket", () => {
  const big: DependencyGraph = {
    ...dense,
    nodes: Array.from({ length: 50 }, (_, index) => node(`T-KQ${index + 1}`)),
    edges: [
      ...Array.from({ length: 30 }, (_, index) => ({
        blocker: "T-KQ1",
        dependent: `T-KQ${index + 2}`,
      })),
      { blocker: "T-KQ40", dependent: "T-KQ41" },
      { blocker: "T-KQ41", dependent: "T-KQ42" },
    ],
  };
  const positions = layoutGraph(big);
  const perRow = new Map<number, number>();
  for (const at of positions.values())
    perRow.set(at.y, (perRow.get(at.y) ?? 0) + 1);
  const linkedRows = [...perRow.entries()].filter(([y]) => y <= 600);
  expect(Math.max(...linkedRows.map(([, count]) => count))).toBeLessThanOrEqual(
    MAX_PER_ROW,
  );
  const size = { width: 1000, height: 650 };
  for (const focus of ["T-KQ41", null]) {
    const open = openViewport(big, positions, focus, size, 0.7)!;
    expect(open.zoom).toBeGreaterThanOrEqual(0.7);
    const target = positions.get(focus ?? "T-KQ1")!;
    const left = target.x * open.zoom + open.x;
    const top = target.y * open.zoom + open.y;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + NODE_WIDTH * open.zoom).toBeLessThanOrEqual(size.width);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + NODE_HEIGHT * open.zoom).toBeLessThanOrEqual(size.height);
  }
});

/** Edges drawn as straight lines between card centres that pass over a card that is neither end. */
function crossings(graph: DependencyGraph) {
  const positions = layoutGraph(graph);
  let count = 0;
  for (const edge of graph.edges) {
    const from = positions.get(edge.blocker)!;
    const to = positions.get(edge.dependent)!;
    for (const [reference, at] of positions) {
      if (reference === edge.blocker || reference === edge.dependent) continue;
      for (let step = 1; step < 50; step += 1) {
        const x = from.x + ((to.x - from.x) * step) / 50 + NODE_WIDTH / 2;
        const y =
          from.y + NODE_HEIGHT + ((to.y - from.y - NODE_HEIGHT) * step) / 50;
        if (
          x > at.x &&
          x < at.x + NODE_WIDTH &&
          y > at.y &&
          y < at.y + NODE_HEIGHT
        ) {
          count += 1;
          break;
        }
      }
    }
  }
  return count;
}

test("an ordinary fan-out stays on one rank, so no edge runs behind another ticket", () => {
  const leaves = Array.from({ length: 10 }, (_, index) => `T-KQ${index + 2}`);
  const fan: DependencyGraph = {
    ...graph,
    nodes: ["T-KQ1", ...leaves, "T-KQ12"].map(node),
    edges: [
      ...leaves.map((leaf) => ({ blocker: "T-KQ1", dependent: leaf })),
      ...leaves.map((leaf) => ({ blocker: leaf, dependent: "T-KQ12" })),
    ],
  };
  const positions = layoutGraph(fan);
  expect(new Set(leaves.map((leaf) => positions.get(leaf)!.y)).size).toBe(1);
  expect(crossings(fan)).toBe(0);
});

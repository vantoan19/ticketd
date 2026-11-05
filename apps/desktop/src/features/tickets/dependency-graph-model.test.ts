import { expect, test } from "vitest";
import type { DependencyGraph } from "@/lib/api/client";
import {
  NODE_HEIGHT,
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
  nodes: [node("T-1"), node("T-2"), node("T-3")],
  edges: [
    { blocker: "T-1", dependent: "T-2" },
    { blocker: "T-2", dependent: "T-3" },
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
  expect(y("T-1")).toBeLessThan(y("T-2"));
  expect(y("T-2")).toBeLessThan(y("T-3"));
});

test("only a limited graph states how far it reaches", () => {
  expect(scopeNotice(graph, "T-2")).toBeNull();
  expect(scopeNotice({ ...graph, truncated: true }, "T-2")).toContain(
    "up to 5 links from T-2 and at most 50 tickets",
  );
});

const dense: DependencyGraph = {
  ...graph,
  nodes: Array.from({ length: 55 }, (_, index) => node(`T-${index + 1}`)),
  edges: [
    ...Array.from({ length: 12 }, (_, index) => ({
      blocker: "T-1",
      dependent: `T-${index + 2}`,
    })),
    { blocker: "T-2", dependent: "T-20" },
    { blocker: "T-20", dependent: "T-21" },
  ],
};

test("a hub with many dependents wraps into rows within a width budget", () => {
  const positions = layoutGraph(dense);
  const bounds = boundsOf(positions, positions.keys());
  expect(bounds!.width).toBeLessThanOrEqual(8 * (NODE_WIDTH + 32));
  expect(positions.get("T-1")!.y).toBeLessThan(positions.get("T-2")!.y);
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
  const hub = positions.get("T-1")!;
  const left = hub.x * open.zoom + open.x;
  expect(left).toBeGreaterThanOrEqual(0);
  expect(left + NODE_WIDTH * open.zoom).toBeLessThanOrEqual(900);
  expect(hub.y * open.zoom + open.y).toBeGreaterThanOrEqual(0);
});

test("a dense graph wraps to five per rank and opens readable on the selected ticket", () => {
  const big: DependencyGraph = {
    ...dense,
    nodes: Array.from({ length: 50 }, (_, index) => node(`T-${index + 1}`)),
    edges: [
      ...Array.from({ length: 24 }, (_, index) => ({
        blocker: "T-1",
        dependent: `T-${index + 2}`,
      })),
      { blocker: "T-40", dependent: "T-41" },
      { blocker: "T-41", dependent: "T-42" },
    ],
  };
  const positions = layoutGraph(big);
  const perRow = new Map<number, number>();
  for (const at of positions.values())
    perRow.set(at.y, (perRow.get(at.y) ?? 0) + 1);
  const linkedRows = [...perRow.entries()].filter(([y]) => y <= 600);
  expect(Math.max(...linkedRows.map(([, count]) => count))).toBeLessThanOrEqual(
    5,
  );
  const size = { width: 1000, height: 650 };
  for (const focus of ["T-41", null]) {
    const open = openViewport(big, positions, focus, size, 0.7)!;
    expect(open.zoom).toBeGreaterThanOrEqual(0.7);
    const target = positions.get(focus ?? "T-1")!;
    const left = target.x * open.zoom + open.x;
    const top = target.y * open.zoom + open.y;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + NODE_WIDTH * open.zoom).toBeLessThanOrEqual(size.width);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + NODE_HEIGHT * open.zoom).toBeLessThanOrEqual(size.height);
  }
});

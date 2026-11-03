import { expect, test } from "vitest";
import type { DependencyGraph } from "@/lib/api/client";
import { layoutGraph, scopeNotice } from "./dependency-graph-model";

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

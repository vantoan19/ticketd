import dagre from "@dagrejs/dagre";
import type { DependencyGraph } from "@/lib/api/client";

export const NODE_WIDTH = 224;
export const NODE_HEIGHT = 76;

export type GraphTicket = DependencyGraph["nodes"][number];

/** Top-left positions with blockers above the tickets they block. */
export function layoutGraph(graph: DependencyGraph) {
  const layout = new dagre.graphlib.Graph()
    .setGraph({ rankdir: "TB", nodesep: 32, ranksep: 64 })
    .setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes)
    layout.setNode(node.reference, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of graph.edges) layout.setEdge(edge.blocker, edge.dependent);
  dagre.layout(layout);
  return new Map(
    graph.nodes.map((node) => {
      const { x, y } = layout.node(node.reference) as { x: number; y: number };
      return [
        node.reference,
        { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 },
      ] as const;
    }),
  );
}

/** The tickets that wait on `reference`, and the tickets it waits on. */
export function neighbours(graph: DependencyGraph, reference: string) {
  const byReference = new Map(
    graph.nodes.map((node) => [node.reference, node]),
  );
  const pick = (references: string[]) =>
    references.flatMap((item) => byReference.get(item) ?? []);
  return {
    blocks: pick(
      graph.edges
        .filter((edge) => edge.blocker === reference)
        .map((edge) => edge.dependent),
    ),
    blockedBy: pick(
      graph.edges
        .filter((edge) => edge.dependent === reference)
        .map((edge) => edge.blocker),
    ),
  };
}

/** How far a limited graph reaches, or null when nothing was cut off. */
export function scopeNotice(graph: DependencyGraph, origin: string) {
  if (!graph.truncated) return null;
  return `This graph is limited. It reaches up to ${graph.max_depth} links from ${origin} and at most ${graph.max_nodes} tickets, so some relationships are not shown.`;
}

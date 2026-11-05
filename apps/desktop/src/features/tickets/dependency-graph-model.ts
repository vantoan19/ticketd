import dagre from "@dagrejs/dagre";
import type { DependencyGraph } from "@/lib/api/client";

export const NODE_WIDTH = 224;
export const NODE_HEIGHT = 76;

export type GraphTicket = DependencyGraph["nodes"][number];

/** Top-left positions with blockers above the tickets they block. Tickets with no
 * edge are packed in a wrapped grid below, so they never form one very wide rank. */
export function layoutGraph(graph: DependencyGraph) {
  const connected = new Set(
    graph.edges.flatMap((edge) => [edge.blocker, edge.dependent]),
  );
  const linked = graph.nodes.filter((node) => connected.has(node.reference));
  const loose = graph.nodes.filter((node) => !connected.has(node.reference));
  const positions = new Map<string, { x: number; y: number }>();
  let bottom = 0;
  if (linked.length > 0) {
    const layout = new dagre.graphlib.Graph()
      .setGraph({ rankdir: "TB", nodesep: 32, ranksep: 64 })
      .setDefaultEdgeLabel(() => ({}));
    for (const node of linked)
      layout.setNode(node.reference, {
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    for (const edge of graph.edges)
      layout.setEdge(edge.blocker, edge.dependent);
    dagre.layout(layout);
    for (const node of linked) {
      const { x, y } = layout.node(node.reference) as { x: number; y: number };
      positions.set(node.reference, {
        x: x - NODE_WIDTH / 2,
        y: y - NODE_HEIGHT / 2,
      });
      bottom = Math.max(bottom, y + NODE_HEIGHT / 2);
    }
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(loose.length * 2)));
  const top = linked.length > 0 ? bottom + 64 : 0;
  loose.forEach((node, index) => {
    positions.set(node.reference, {
      x: (index % columns) * (NODE_WIDTH + 32),
      y: top + Math.floor(index / columns) * (NODE_HEIGHT + 32),
    });
  });
  return positions;
}

/** How far a limited graph reaches, or null when nothing was cut off. */
export function scopeNotice(graph: DependencyGraph, origin: string) {
  if (!graph.truncated) return null;
  return `This graph is limited. It reaches up to ${graph.max_depth} links from ${origin} and at most ${graph.max_nodes} tickets and ${graph.max_edges} relationships. Some tickets or relationships may be missing. Select a ticket and center the graph on it to explore further.`;
}

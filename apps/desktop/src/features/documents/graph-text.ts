import { MarkerType, type Edge } from "@xyflow/react";
import type { ContextGraph } from "@/lib/api/client";

type GraphNode = ContextGraph["nodes"][number];
type GraphEdge = ContextGraph["edges"][number];

export const edgeLabels: Record<string, string> = {
  blocks: "Blocks",
  membership: "Plan membership",
  document: "Plan document",
  spec: "Primary spec",
  mention: "Mentions",
  activity: "Update mentions",
  support: "Update cites",
};

/** Relationships that are weaker than a rule; drawn dashed. */
export const dashedKinds = new Set(["mention", "activity"]);

export const kindNames: Record<GraphNode["kind"], string> = {
  ticket: "Ticket",
  document: "Document",
  plan: "Plan",
};

/** Passages are stored Markdown; show the link text, not the link. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/ticketd:\/\/\S+/g, "")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function name(node: GraphNode | undefined, fallback: string): string {
  if (!node) return fallback;
  return node.ticket_reference ?? node.label;
}

/** One sentence saying why two items are connected, in the edge's direction. */
export function describeEdge(
  edge: GraphEdge,
  nodes: Map<string, GraphNode>,
): string {
  const source = name(nodes.get(edge.source), "an item");
  const target = name(nodes.get(edge.target), "an item");
  const passage = edge.explanation ? plainText(edge.explanation) : "";
  const quoted = passage ? `: “${passage}”` : "";
  switch (edge.kind) {
    case "blocks":
      return `${source} must be Done before ${target} is Ready`;
    case "membership":
      return `${target} is in plan ${source}`;
    case "document":
      return `${target} is a document of plan ${source}`;
    case "spec":
      return `${target} is the primary spec of plan ${source}`;
    case "mention":
      return `${source} mentions ${target}${quoted}`;
    case "activity":
      return `An update on ${source} mentions ${target}${quoted}`;
    case "support":
      return `An update on ${source} cites ${target}${quoted}`;
  }
}

/** React Flow edges that show direction and relationship, one per connection. */
export function flowEdges(edges: GraphEdge[]): Edge[] {
  return edges.map((edge, index) => ({
    id: `${index}`,
    source: edge.source,
    target: edge.target,
    label: edgeLabels[edge.kind] ?? edge.kind,
    animated: false,
    // currentColor follows the themed .react-flow__edges color.
    markerEnd: { type: MarkerType.ArrowClosed, color: "currentColor" },
    style: dashedKinds.has(edge.kind) ? { strokeDasharray: "5 5" } : {},
  }));
}

/** Connections touching a node, one row per relationship between the same pair. */
export function connectionRows(
  nodeId: string,
  graph: Pick<ContextGraph, "nodes" | "edges">,
): { key: string; kind: string; text: string }[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const rows = new Map<
    string,
    { kind: string; edge: GraphEdge; extra: number }
  >();
  for (const edge of graph.edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    const key = `${edge.kind}:${edge.source}:${edge.target}`;
    const existing = rows.get(key);
    if (existing) existing.extra += 1;
    else rows.set(key, { kind: edge.kind, edge, extra: 0 });
  }
  return [...rows.entries()].map(([key, row]) => ({
    key,
    kind: row.kind,
    text:
      describeEdge(row.edge, byId) + (row.extra ? ` (+${row.extra} more)` : ""),
  }));
}

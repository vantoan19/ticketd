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
  attached: "Attached",
  activity: "Update mentions",
  support: "Update cites",
  subticket: "Subticket",
  related: "Related",
  discovered: "Discovered",
};

/**
 * Four line styles, each with its own dash and colour so they differ without
 * relying on either alone: rules (blocks), plan structure, work hierarchy and
 * references.
 */
export type EdgeStyle = {
  name: string;
  kinds: string[];
  dash: string | undefined;
  width: number;
  color: string;
};
export const edgeStyles: EdgeStyle[] = [
  {
    name: "Blocks",
    kinds: ["blocks"],
    dash: undefined,
    width: 2.5,
    color: "currentColor",
  },
  {
    name: "Plan membership, documents, Primary spec",
    kinds: ["membership", "document", "spec"],
    dash: "2 4",
    width: 1.5,
    color: "#4f8ef7",
  },
  {
    name: "Subticket, Related, Discovered",
    kinds: ["subticket", "related", "discovered"],
    dash: "10 4",
    width: 1.5,
    color: "#b07cf0",
  },
  {
    name: "Mentions, Attached, Update mentions, Update cites",
    kinds: ["mention", "attached", "activity", "support"],
    dash: "4 3 1 3",
    width: 1.5,
    color: "#e0a030",
  },
];
export function edgeStyle(kind: string): EdgeStyle {
  return (
    edgeStyles.find((style) => style.kinds.includes(kind)) ?? edgeStyles[3]!
  );
}

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
  // A passage that only repeats an item's own name adds nothing.
  const repeats = [nodes.get(edge.source), nodes.get(edge.target)].some(
    (node) =>
      node &&
      [node.label, node.ticket_reference ?? ""].some(
        (text) => text && plainText(text) === passage,
      ),
  );
  const quoted = passage && !repeats ? `: “${passage}”` : "";
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
    case "attached":
      return `${source} has ${target}`;
    case "activity":
      return `An update on ${source} mentions ${target}${quoted}`;
    case "support":
      return `An update on ${source} cites ${target}${quoted}`;
    case "subticket":
      return `${target} is a subticket of ${source}`;
    case "related":
      return `${source} is related to ${target}`;
    case "discovered":
      return `${target} was discovered while working on ${source}`;
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
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: edgeStyle(edge.kind).color,
    },
    // Straight lines between card centres never loop around a card.
    type: "straight",
    style: {
      strokeWidth: edgeStyle(edge.kind).width,
      stroke: edgeStyle(edge.kind).color,
      ...(edgeStyle(edge.kind).dash
        ? { strokeDasharray: edgeStyle(edge.kind).dash }
        : {}),
    },
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

/** More neighbours than this open as a grouped list; the map is one click away. */
export const LIST_FIRST_LIMIT = 12;
/** A map needs the whole neighbourhood to be readable, so a very dense one stays a list. */
export const MAP_LIMIT = 30;
/** Cards smaller than this cannot be read. */
export const READABLE_ZOOM = 0.6;

/** Whether the map shows: the person's choice if any, else only a small neighbourhood. */
export function opensAsMap(
  neighbours: number,
  choice: boolean | null,
  limit = MAP_LIMIT,
): boolean {
  return neighbours <= limit && (choice ?? neighbours <= LIST_FIRST_LIMIT);
}

/** Centering keeps the person's zoom, but never leaves a map too small to read. */
export function centerZoom(current: number): number {
  return Math.max(current, READABLE_ZOOM);
}

/**
 * The smallest pan (zoom unchanged) that brings `rect`, in flow coordinates, inside a view of
 * `size` pixels, or the same viewport when it already fits. Existing cards never move.
 */
export function panToInclude(
  viewport: { x: number; y: number; zoom: number },
  size: { width: number; height: number },
  rect: { x: number; y: number; width: number; height: number },
  margin = 24,
): { x: number; y: number; zoom: number } {
  const shift = (
    start: number,
    length: number,
    view: number,
    offset: number,
  ) => {
    const from = start * viewport.zoom + offset;
    const to = (start + length) * viewport.zoom + offset;
    if (to - from + 2 * margin > view) return offset + margin - from;
    if (from < margin) return offset + margin - from;
    if (to > view - margin) return offset + view - margin - to;
    return offset;
  };
  return {
    ...viewport,
    x: shift(rect.x, rect.width, size.width, viewport.x),
    y: shift(rect.y, rect.height, size.height, viewport.y),
  };
}

/** "Active · Trashed · Update details", skipping whatever does not apply. */
export function stateLine(node: {
  state: string | null;
  trashed: boolean;
  activity_detail: boolean;
}): string {
  return [
    node.state,
    node.trashed ? "Trashed" : null,
    node.activity_detail ? "Update details" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

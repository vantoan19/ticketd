import { MarkerType, type Edge } from "@xyflow/react";
import type { ContextGraph } from "@/lib/api/client";
import { plainText } from "@/lib/plain-text";

type GraphNode = ContextGraph["nodes"][number];
type GraphEdge = ContextGraph["edges"][number];

/**
 * The relationship glossary (GLOSSARY.md, "Graph relationships"): each kind
 * has one name, used on the line, in the legend and (capitalised) as the
 * filter label; ROLE_LABELS below name it from either end.
 */
export const edgeLineLabels: Record<string, string> = {
  blocks: "blocks",
  membership: "in Plan",
  document: "document of",
  spec: "spec of",
  mention: "mentions",
  attached: "attached",
  activity: "update mentions",
  support: "update cites",
  subticket: "parent of",
  related: "related",
  discovered: "discovered",
};

/** The same names, capitalised, for filters and group titles. */
export const edgeLabels: Record<string, string> = Object.fromEntries(
  Object.entries(edgeLineLabels).map(([kind, name]) => [
    kind,
    name.charAt(0).toUpperCase() + name.slice(1),
  ]),
);

/**
 * Four line styles, all in the neutral edge colour, told apart by the line
 * alone: "blocks" is the one line with an arrowhead (arrow = waits); work
 * hierarchy is solid, related and Plan structure dashed, references dotted.
 * `mark` is the graph kit's legend sample.
 */
export type EdgeStyle = {
  name: string;
  mark: "blocks" | "line" | "dashed" | "dotted";
  kinds: string[];
  dash: string | undefined;
  width: number;
  color: string;
};
export const edgeStyles: EdgeStyle[] = [
  {
    name: "blocks",
    mark: "blocks",
    kinds: ["blocks"],
    dash: undefined,
    width: 1.75,
    color: "currentColor",
  },
  {
    name: "parent of, discovered",
    mark: "line",
    kinds: ["subticket", "discovered"],
    dash: undefined,
    width: 1.25,
    color: "currentColor",
  },
  {
    name: "related, in Plan, document of, spec of",
    mark: "dashed",
    kinds: ["related", "membership", "document", "spec"],
    dash: "4 3",
    width: 1.25,
    color: "currentColor",
  },
  {
    name: "mentions, attached, update mentions, update cites",
    mark: "dotted",
    kinds: ["mention", "attached", "activity", "support"],
    dash: "1.5 3",
    width: 1.25,
    color: "currentColor",
  },
];
export function edgeStyle(kind: string): EdgeStyle {
  return (
    edgeStyles.find((style) => style.kinds.includes(kind)) ?? edgeStyles[3]!
  );
}

/** The legend for these lines: one sample per style shown, naming only the kinds present. */
export function legendItems(
  kinds: Iterable<string>,
): { mark: EdgeStyle["mark"]; label: string }[] {
  const present = new Set(kinds);
  return edgeStyles.flatMap((style) => {
    const names = style.kinds
      .filter((kind) => present.has(kind))
      .map((kind) => edgeLineLabels[kind] ?? kind);
    return names.length ? [{ mark: style.mark, label: names.join(", ") }] : [];
  });
}

export const kindNames: Record<GraphNode["kind"], string> = {
  ticket: "Ticket",
  document: "Document",
  plan: "Plan",
};

// Passages are stored Markdown; show the link text, not the link.
export { plainText };

/** Equal ignoring case and punctuation. */
function sameWords(a: string, b: string): boolean {
  const norm = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return norm(a) === norm(b);
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
        (text) => text && sameWords(plainText(text), passage),
      ),
  );
  const quoted = passage && !repeats ? `: “${passage}”` : "";
  switch (edge.kind) {
    case "blocks":
      return `${source} must be Done before ${target} is Ready`;
    case "membership":
      return `${target} is in Plan ${source}`;
    case "document":
      return `${target} is a document of Plan ${source}`;
    case "spec":
      return `${target} is the primary spec of Plan ${source}`;
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

/**
 * React Flow edges, one per connection, each named on the line. Only "blocks"
 * has an arrowhead (the legend's "arrow = waits"); every other line is named by
 * its label, so an arrow there would claim a direction the legend denies.
 */
export function flowEdges(edges: GraphEdge[]): Edge[] {
  return edges.map((edge, index) => ({
    id: `${index}`,
    source: edge.source,
    target: edge.target,
    label: edgeLineLabels[edge.kind] ?? edge.kind,
    // The relationship, for the legend.
    data: { kind: edge.kind },
    animated: false,
    // currentColor follows the themed .react-flow__edges color.
    ...(edge.kind === "blocks" && {
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edgeStyle(edge.kind).color,
      },
    }),
    // Drawn by RoutedEdge, which bends each line around the cards in its way.
    type: "routed",
    style: {
      strokeWidth: edgeStyle(edge.kind).width,
      stroke: edgeStyle(edge.kind).color,
      ...(edgeStyle(edge.kind).dash
        ? { strokeDasharray: edgeStyle(edge.kind).dash }
        : {}),
    },
  }));
}

/** The parts a map card shows: a reference, a title and a "Ticket · Todo" caption. */
export function cardParts(node: GraphNode): {
  ref: string;
  title: string;
  caption: string;
} {
  const match = /^(\S+-[A-Z]*\d+) · (.*)$/.exec(node.label);
  const ref = node.ticket_reference ?? match?.[1] ?? "";
  const title = match && match[1] === ref ? match[2]! : node.label;
  return {
    ref,
    title: node.trashed ? `${title} (Trash)` : title,
    caption: [kindNames[node.kind], node.state].filter(Boolean).join(" · "),
  };
}

/** Each relationship named from either end: [from the source, from the target]. */
const ROLE_LABELS: Record<string, [outgoing: string, incoming: string]> = {
  blocks: ["Blocks", "Blocked by"],
  subticket: ["Parent of", "Subticket of"],
  related: ["Related to", "Related to"],
  discovered: ["Discovered", "Discovered from"],
  mention: ["Mentions", "Mentioned by"],
  attached: ["Has attached", "Attached to"],
  activity: ["Update mentions", "Mentioned in an update on"],
  support: ["Update cites", "Cited in an update on"],
  membership: ["Contains", "In Plan"],
  document: ["Has document", "Document of"],
  spec: ["Has spec", "Spec of"],
};

/** A relationship named from `nodeId`'s side: T-FV1 is "Blocked by" T-FV14, not "Blocks". */
function roleLabel(edge: GraphEdge, nodeId: string): string {
  const pair = ROLE_LABELS[edge.kind] ?? [
    edgeLabels[edge.kind] ?? edge.kind,
    edgeLabels[edge.kind] ?? edge.kind,
  ];
  return edge.source === nodeId ? pair[0] : pair[1];
}

/**
 * Connections touching a node, one row per relationship between the same pair.
 * `label` names the relationship from this node's side.
 */
export function connectionRows(
  nodeId: string,
  graph: Pick<ContextGraph, "nodes" | "edges">,
): { key: string; kind: string; label: string; text: string }[] {
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
    label: roleLabel(row.edge, nodeId),
    text:
      describeEdge(row.edge, byId) + (row.extra ? ` (+${row.extra} more)` : ""),
  }));
}

/** A node's connections as labelled rows ("Blocked by", "Parent of", "Mentioned by"), each item once. */
export function labelledConnections(
  nodeId: string,
  graph: Pick<ContextGraph, "nodes" | "edges">,
): { label: string; items: { id: string; text: string }[] }[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const rows = new Map<string, { id: string; text: string }[]>();
  for (const edge of graph.edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    const outgoing = edge.source === nodeId;
    const other = byId.get(outgoing ? edge.target : edge.source);
    if (!other) continue;
    const label = roleLabel(edge, nodeId);
    const parts = cardParts(other);
    const text = [parts.ref, parts.title].filter(Boolean).join(" ");
    const items = rows.get(label) ?? [];
    if (!items.some((item) => item.id === other.id))
      items.push({ id: other.id, text });
    rows.set(label, items);
  }
  return [...rows].map(([label, items]) => ({ label, items }));
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
 * `size` pixels, or the same viewport when it already fits. With `keep` (the cards now in view),
 * those stay fully visible too: when all of it cannot fit, the zoom drops (never below
 * readable) instead of clipping a card.
 */
export function panToInclude(
  viewport: { x: number; y: number; zoom: number },
  size: { width: number; height: number },
  rect: { x: number; y: number; width: number; height: number },
  margin = 24,
  keep?: { x: number; y: number; width: number; height: number },
): { x: number; y: number; zoom: number } {
  // Cards already in view must stay fully visible, so the pan covers them too.
  if (keep) {
    const x = Math.min(rect.x, keep.x);
    const y = Math.min(rect.y, keep.y);
    rect = {
      x,
      y,
      width: Math.max(rect.x + rect.width, keep.x + keep.width) - x,
      height: Math.max(rect.y + rect.height, keep.y + keep.height) - y,
    };
  }
  let zoom = viewport.zoom;
  let zoomed = false;
  if (keep) {
    // Everything that must stay visible does not fit at this zoom: zoom out, but
    // never below readable.
    const need = Math.min(
      (size.width - 2 * margin) / rect.width,
      (size.height - 2 * margin) / rect.height,
    );
    if (need < zoom) {
      zoom = Math.max(need, READABLE_ZOOM);
      zoomed = true;
    }
  }
  const shift = (
    start: number,
    length: number,
    view: number,
    offset: number,
  ) => {
    if (zoomed) {
      const slack = Math.max(0, view - 2 * margin - length * zoom);
      return margin + slack / 2 - start * zoom;
    }
    const from = start * zoom + offset;
    const to = (start + length) * zoom + offset;
    if (to - from + 2 * margin > view) return offset + margin - from;
    if (from < margin) return offset + margin - from;
    if (to > view - margin) return offset + view - margin - to;
    return offset;
  };
  return {
    zoom,
    x: shift(rect.x, rect.width, size.width, viewport.x),
    y: shift(rect.y, rect.height, size.height, viewport.y),
  };
}

/**
 * The view that fits `bounds` (flow coordinates) into a view of `size` pixels
 * inside `padding`, zoomed within `zoom`. It is React Flow's fit, except for
 * one case: a graph larger than the view at the lowest zoom (Fit never goes
 * below 100%) is aligned to the top and left padding, so the view opens on the
 * start of the graph rather than partway down its middle.
 */
export function fitViewport(
  bounds: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
  padding: { top: number; right: number; bottom: number; left: number },
  zoom: { min: number; max: number },
): { x: number; y: number; zoom: number } {
  const room = {
    width: size.width - padding.left - padding.right,
    height: size.height - padding.top - padding.bottom,
  };
  const fitted = Math.min(
    room.width / bounds.width,
    room.height / bounds.height,
  );
  const scale = Math.min(zoom.max, Math.max(zoom.min, fitted));
  const place = (
    start: number,
    length: number,
    space: number,
    before: number,
  ) => {
    const shown = length * scale;
    // Centred when it fits; otherwise its start sits on the padding.
    const slack = Math.max(0, space - shown);
    return before + slack / 2 - start * scale;
  };
  return {
    zoom: scale,
    x: place(bounds.x, bounds.width, room.width, padding.left),
    y: place(bounds.y, bounds.height, room.height, padding.top),
  };
}

/** "Open T-FV1", "Open Plan", "Open Document". */
export function openLabel(node: GraphNode) {
  const ref = cardParts(node).ref;
  return ref ? `Open ${ref}` : `Open ${kindNames[node.kind]}`;
}

/** An item's status word, for its glyph: "Todo" from "Todo · Ready". */
export function statusOf(node: { state: string | null }) {
  return node.state?.split(" · ")[0] ?? "";
}

/**
 * Why two items are connected, in the source's words, when an edge between
 * them carries a passage: "“Read this”". Empty when none does.
 */
export function passageBetween(
  a: string,
  b: string,
  graph: Pick<ContextGraph, "edges">,
): string {
  const edge = graph.edges.find(
    (item) =>
      item.explanation &&
      ((item.source === a && item.target === b) ||
        (item.source === b && item.target === a)),
  );
  const passage = edge?.explanation ? plainText(edge.explanation) : "";
  return passage ? `“${passage}”` : "";
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

/** A graph card accessible name: its kind, its label, and a Trash suffix. */
export function nodeAriaLabel(node: GraphNode): string {
  return `${kindNames[node.kind]}: ${node.label}${node.trashed ? " (Trash)" : ""}`;
}

/** A node's name in a list: its label with a Trash suffix when it is trashed. */
export function nodeName(node: { label: string; trashed: boolean }): string {
  return `${node.label}${node.trashed ? " (Trash)" : ""}`;
}

/**
 * Whether a React Flow move-start event is the person's own pan or zoom. A
 * programmatic move (Fit, or the controlled viewport syncing back into the
 * canvas) carries no DOM event, or a plain `{ sync: true }` marker object.
 */
export function isUserMove(event: unknown): boolean {
  return typeof Event !== "undefined" && event instanceof Event;
}

/**
 * How many cards are not entirely inside a view of this size: wholly outside
 * or cut by an edge. `cards` are in flow units, `view` is the pan and zoom.
 */
export function countNotFullyShown(
  cards: { x: number; y: number; width: number; height: number }[],
  view: { x: number; y: number; zoom: number },
  size: { width: number; height: number },
): number {
  if (!size.width || !size.height) return 0;
  // Half a pixel of rounding is not a clipped card.
  const slack = 0.5;
  let count = 0;
  for (const card of cards) {
    const left = card.x * view.zoom + view.x;
    const top = card.y * view.zoom + view.y;
    if (
      left < -slack ||
      top < -slack ||
      left + card.width * view.zoom > size.width + slack ||
      top + card.height * view.zoom > size.height + slack
    )
      count++;
  }
  return count;
}

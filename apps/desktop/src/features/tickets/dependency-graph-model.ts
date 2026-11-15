import dagre from "@dagrejs/dagre";
import type { DependencyGraph } from "@/lib/api/client";

export const NODE_WIDTH = 224;
export const NODE_HEIGHT = 64;

/** Widest rank drawn on one row; wider ranks wrap onto more rows. */
export const MAX_PER_ROW = 8;
/** Above this many linked tickets rows are narrower, so the graph stays readable. */
export const DENSE_NODES = 8;
export const DENSE_PER_ROW = 4;
const COLUMN_GAP = 32;
const ROW_GAP = 64;

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
    // dagre puts every dependent of a hub on one rank, which can be thousands
    // of pixels wide. Wrap each rank into rows of at most MAX_PER_ROW, keeping
    // dagre's left-to-right order and centering each row on the rank.
    const ranks = new Map<number, { reference: string; x: number }[]>();
    for (const node of linked) {
      const { x, y } = layout.node(node.reference) as { x: number; y: number };
      ranks.set(y, [...(ranks.get(y) ?? []), { reference: node.reference, x }]);
    }
    const perRow = linked.length > DENSE_NODES ? DENSE_PER_ROW : MAX_PER_ROW;
    const wide = [...ranks.values()].some((rank) => rank.length > perRow);
    const all = [...ranks.values()].flat();
    const middle =
      (Math.min(...all.map((m) => m.x)) + Math.max(...all.map((m) => m.x))) / 2;
    let y = 0;
    for (const rank of [...ranks.entries()].sort(([a], [b]) => a - b)) {
      const members = rank[1].sort((a, b) => a.x - b.x);
      for (let start = 0; start < members.length; start += perRow) {
        const row = members.slice(start, start + perRow);
        // Without a wide rank dagre's own alignment is kept. With one, every
        // rank is repacked around a shared center so narrow ranks stay under it.
        const left =
          (wide ? middle : (row[0]!.x + row[row.length - 1]!.x) / 2) -
          ((row.length - 1) * (NODE_WIDTH + COLUMN_GAP)) / 2;
        row.forEach((member, column) =>
          positions.set(member.reference, {
            x:
              (wide ? left + column * (NODE_WIDTH + COLUMN_GAP) : member.x) -
              NODE_WIDTH / 2,
            y,
          }),
        );
        const more = start + perRow < members.length;
        y += NODE_HEIGHT + (more ? 32 : ROW_GAP);
      }
    }
    bottom = y - ROW_GAP;
  }
  const columns = Math.min(
    MAX_PER_ROW,
    Math.max(1, Math.ceil(Math.sqrt(loose.length * 2))),
  );
  // Line the loose grid up with the left edge of the linked tickets above it.
  const left = positions.size
    ? Math.min(...[...positions.values()].map((at) => at.x))
    : 0;
  const top = linked.length > 0 ? bottom + 64 : 0;
  loose.forEach((node, index) => {
    positions.set(node.reference, {
      x: left + (index % columns) * (NODE_WIDTH + 32),
      y: top + Math.floor(index / columns) * (NODE_HEIGHT + 32),
    });
  });
  return positions;
}

/** How far a limited graph reaches, or null when nothing was cut off. */
export function scopeNotice(graph: DependencyGraph, origin: string) {
  if (!graph.truncated) return null;
  return `Showing up to ${graph.max_depth} links from ${origin} and at most ${graph.max_nodes} tickets · center on a ticket to go further`;
}

export type Rect = { x: number; y: number; width: number; height: number };
export type Viewport = { x: number; y: number; zoom: number };

/** The smallest rectangle holding the given tickets, or null for none. */
export function boundsOf(
  positions: Map<string, { x: number; y: number }>,
  references: Iterable<string>,
): Rect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const reference of references) {
    const at = positions.get(reference);
    if (!at) continue;
    left = Math.min(left, at.x);
    top = Math.min(top, at.y);
    right = Math.max(right, at.x + NODE_WIDTH);
    bottom = Math.max(bottom, at.y + NODE_HEIGHT);
  }
  if (left === Infinity) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

type Padding = { top: number; right: number; bottom: number; left: number };
/** Leaves room for the legend above and the zoom control below. */
export const FIT_PADDING: Padding = {
  top: 52,
  right: 24,
  bottom: 52,
  left: 24,
};

/**
 * A viewport showing `bounds` as large as `maxZoom` allows, but never smaller
 * than `minZoom`. When even `minZoom` is too large the bounds are centered
 * across and pinned to the top, so some of the tickets are always in view.
 */
export function fitViewport(
  bounds: Rect,
  size: { width: number; height: number },
  { minZoom, maxZoom }: { minZoom: number; maxZoom: number },
  padding: Padding = FIT_PADDING,
): Viewport {
  const room = {
    width: Math.max(1, size.width - padding.left - padding.right),
    height: Math.max(1, size.height - padding.top - padding.bottom),
  };
  const zoom = Math.min(
    maxZoom,
    Math.max(
      minZoom,
      Math.min(room.width / bounds.width, room.height / bounds.height),
    ),
  );
  const slack = room.width - bounds.width * zoom;
  const x = padding.left + slack / 2 - bounds.x * zoom;
  const yBase = padding.top - bounds.y * zoom;
  const spare = room.height - bounds.height * zoom;
  return { x, y: yBase + Math.max(0, spare) / 2, zoom };
}

/** The tickets joined to `origin` by any chain of links, else the largest such group. */
export function focusGroup(graph: DependencyGraph, origin: string) {
  const neighbors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    neighbors.set(edge.blocker, [
      ...(neighbors.get(edge.blocker) ?? []),
      edge.dependent,
    ]);
    neighbors.set(edge.dependent, [
      ...(neighbors.get(edge.dependent) ?? []),
      edge.blocker,
    ]);
  }
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const node of graph.nodes) {
    if (seen.has(node.reference) || !neighbors.has(node.reference)) continue;
    const group: string[] = [];
    const pending = [node.reference];
    seen.add(node.reference);
    while (pending.length > 0) {
      const next = pending.pop()!;
      group.push(next);
      for (const other of neighbors.get(next) ?? [])
        if (!seen.has(other)) {
          seen.add(other);
          pending.push(other);
        }
    }
    groups.push(group);
  }
  return (
    groups.find((group) => group.includes(origin)) ??
    groups.reduce<string[]>(
      (best, group) => (group.length > best.length ? group : best),
      [],
    )
  );
}

/** The ticket and the tickets directly linked to it. */
function neighbourhood(graph: DependencyGraph, reference: string) {
  const near = new Set([reference]);
  for (const edge of graph.edges) {
    if (edge.blocker === reference) near.add(edge.dependent);
    if (edge.dependent === reference) near.add(edge.blocker);
  }
  return near;
}

/** The focus ticket if it is in the graph, else the one with most links. */
function focusTicket(graph: DependencyGraph, focus: string | null) {
  if (focus && graph.nodes.some((node) => node.reference === focus))
    return focus;
  const degree = new Map<string, number>();
  for (const edge of graph.edges)
    for (const reference of [edge.blocker, edge.dependent])
      degree.set(reference, (degree.get(reference) ?? 0) + 1);
  let best: string | null = null;
  for (const node of byReference(graph.nodes))
    if ((degree.get(node.reference) ?? 0) > (degree.get(best ?? "") ?? 0))
      best = node.reference;
  return best;
}

/**
 * Where a graph opens: everything when that stays readable, otherwise the
 * neighbourhood of the focus ticket (the selected or opened one, else the most
 * connected) at no less than the readable zoom, centred on that ticket.
 */
export function openViewport(
  graph: DependencyGraph,
  positions: Map<string, { x: number; y: number }>,
  focus: string | null,
  size: { width: number; height: number },
  readableZoom: number,
): Viewport | null {
  const all = boundsOf(positions, positions.keys());
  if (!all) return null;
  const whole = fitViewport(all, size, { minZoom: 0, maxZoom: 1 });
  if (whole.zoom >= readableZoom) return whole;
  const center = focusTicket(graph, focus);
  const near = center ? neighbourhood(graph, center) : [];
  const group = boundsOf(positions, near) ?? all;
  const view = fitViewport(group, size, { minZoom: readableZoom, maxZoom: 1 });
  const at = center ? positions.get(center) : undefined;
  if (!at) return view;
  // When the neighbourhood overflows the pane, keep the focus ticket in view.
  const left = at.x * view.zoom + view.x;
  const top = at.y * view.zoom + view.y;
  const fits =
    left >= 0 &&
    left + NODE_WIDTH * view.zoom <= size.width &&
    top >= 0 &&
    top + NODE_HEIGHT * view.zoom <= size.height;
  if (fits) return view;
  return {
    zoom: view.zoom,
    x: size.width / 2 - (at.x + NODE_WIDTH / 2) * view.zoom,
    y: size.height / 2 - (at.y + NODE_HEIGHT / 2) * view.zoom,
  };
}

/** Tickets by device code, then counter (T-KQ9 before T-KQ10), so a list reads the same every time. */
export function byReference<T extends { reference: string }>(items: T[]) {
  return [...items].sort((a, b) =>
    a.reference.localeCompare(b.reference, undefined, { numeric: true }),
  );
}

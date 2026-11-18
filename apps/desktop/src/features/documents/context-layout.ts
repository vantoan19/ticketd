import { labelSize, segmentHitsRect } from "./edge-routing";

export type Point = { x: number; y: number };
export type LayoutRequest = {
  nodes: string[];
  /** `label` is the text drawn on the line; the layout leaves room for it. */
  edges: { source: string; target: string; label?: string }[];
  positions: Record<string, Point>;
  /** The item the map is about; it sits in the middle with the rest around it. */
  center?: string;
};

/** Card footprint the layout keeps clear, matching the rendered node size. */
export const CARD_WIDTH = 224;
export const CARD_HEIGHT = 64;
const GAP = 24;
const MID = { x: 400, y: 240 };
/** Room the arrowhead takes at the target end of a line. */
const ARROW = 14;
/** Clear space kept on each side of a label, along the line. */
const LABEL_PAD = 10;

/** How far a card reaches from its middle in the direction of the unit vector (ux, uy). */
function reach(ux: number, uy: number): number {
  return Math.min(
    ux === 0 ? Infinity : CARD_WIDTH / 2 / Math.abs(ux),
    uy === 0 ? Infinity : CARD_HEIGHT / 2 / Math.abs(uy),
  );
}

/**
 * The free length a line needs between its two cards so its label, a clear
 * margin on each side of it and the arrowhead all fit on the line itself.
 */
function freeLength(label: string | undefined, ux: number, uy: number) {
  const size = labelSize(label ?? "");
  const along = label
    ? Math.abs(ux) * size.width + Math.abs(uy) * size.height
    : 0;
  return along + 2 * LABEL_PAD + ARROW;
}

type LayoutEdge = LayoutRequest["edges"][number];

/** Concentric rings sized by card footprint, so a dense set starts without overlap. */
function ringPlacement(ids: string[], center?: string): Record<string, Point> {
  const points: Record<string, Point> = {};
  if (!center) {
    // Nothing is central (the workspace map): a compact, nearly square grid fits
    // the view at a larger zoom than rings do, and the forces then pull
    // connected cards together.
    const columns = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
    ids.forEach((id, index) => {
      points[id] = {
        x: MID.x + (index % columns) * (CARD_WIDTH + GAP),
        y: MID.y + Math.floor(index / columns) * (CARD_HEIGHT + GAP),
      };
    });
    return points;
  }
  const rest = ids.filter((id) => id !== center);
  if (center && ids.includes(center)) points[center] = { ...MID };
  let index = 0;
  let ring = 0;
  while (index < rest.length) {
    const radius = 280 + ring * (CARD_HEIGHT + GAP + 40);
    const capacity = Math.max(
      6,
      Math.floor((2 * Math.PI * radius) / (CARD_WIDTH + GAP)),
    );
    const count = Math.min(capacity, rest.length - index);
    for (let i = 0; i < count; i++) {
      const angle =
        (2 * Math.PI * (i + (ring % 2) * 0.5)) / count - Math.PI / 2;
      points[rest[index + i]!] = {
        x: MID.x + radius * Math.cos(angle),
        y: MID.y + radius * Math.sin(angle) * 0.8,
      };
    }
    index += count;
    ring++;
  }
  return points;
}

/** Pushes overlapping cards apart; cards that already had a position stay put. */
function separate(
  ids: string[],
  points: Record<string, Point>,
  fixed: Set<string>,
): boolean {
  let any = false;
  const w = CARD_WIDTH + GAP;
  const h = CARD_HEIGHT + GAP;
  for (let pass = 0; pass < 600; pass++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = points[ids[i]!]!;
        const b = points[ids[j]!]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = w - Math.abs(dx);
        const overlapY = h - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const fa = fixed.has(ids[i]!);
        const fb = fixed.has(ids[j]!);
        if (fa && fb) continue;
        moved = true;
        // Separate along the shorter way out; exact ties split by index.
        const alongX = overlapX < overlapY;
        const sign =
          (alongX ? dx : dy) === 0
            ? i % 2
              ? 1
              : -1
            : Math.sign(alongX ? dx : dy);
        const push = (alongX ? overlapX : overlapY) + 0.5;
        const shareA = fa ? 0 : fb ? 1 : 0.5;
        const shareB = fb ? 0 : fa ? 1 : 0.5;
        if (alongX) {
          a.x -= sign * push * shareA;
          b.x += sign * push * shareB;
        } else {
          a.y -= sign * push * shareA;
          b.y += sign * push * shareB;
        }
      }
    }
    if (!moved) return any;
    any = true;
  }
  return any;
}

/**
 * Pushes the cards at the two ends of a line apart until the line has a free
 * stretch long enough for its label and arrowhead. Positioned cards stay put.
 */
function spaceEdges(
  edges: LayoutEdge[],
  points: Record<string, Point>,
  fixed: Set<string>,
): boolean {
  let moved = false;
  for (const edge of edges) {
    const a = points[edge.source];
    const b = points[edge.target];
    if (!a || !b || edge.source === edge.target) continue;
    const fa = fixed.has(edge.source);
    const fb = fixed.has(edge.target);
    if (fa && fb) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    // Coincident middles have no direction: spread sideways.
    const ux = d < 1e-3 ? 1 : dx / d;
    const uy = d < 1e-3 ? 0 : dy / d;
    const short = freeLength(edge.label, ux, uy) - (d - 2 * reach(ux, uy));
    if (short <= 0.5) continue;
    moved = true;
    const push = short + 1;
    const shareA = fa ? 0 : fb ? 1 : 0.5;
    const shareB = fb ? 0 : fa ? 1 : 0.5;
    a.x -= ux * push * shareA;
    a.y -= uy * push * shareA;
    b.x += ux * push * shareB;
    b.y += uy * push * shareB;
  }
  return moved;
}

function overlaps(a: Point, b: Point): boolean {
  return (
    Math.abs(a.x - b.x) < CARD_WIDTH + GAP &&
    Math.abs(a.y - b.y) < CARD_HEIGHT + GAP
  );
}

/**
 * Pushing cards apart can stall when new cards are squeezed between ones that
 * must not move. Any new card still touching another goes to the nearest free
 * spot instead, so an added card never covers an existing one.
 */
function settle(
  ids: string[],
  points: Record<string, Point>,
  fixed: Set<string>,
) {
  const placed = ids.filter((id) => fixed.has(id));
  for (const id of ids) {
    if (fixed.has(id)) continue;
    const at = points[id]!;
    const free = (point: Point) =>
      placed.every((other) => !overlaps(point, points[other]!));
    if (!free(at)) {
      search: for (let radius = 20; radius < 4000; radius += 20) {
        const steps = Math.max(8, Math.round(radius / 10));
        for (let step = 0; step < steps; step++) {
          const angle = (2 * Math.PI * step) / steps;
          const candidate = {
            x: at.x + radius * Math.cos(angle),
            y: at.y + radius * Math.sin(angle) * 0.6,
          };
          if (free(candidate)) {
            points[id] = candidate;
            break search;
          }
        }
      }
    }
    placed.push(id);
  }
}

/** What one card position costs the lines: each line through another card counts heavily, length lightly. */
const THROUGH_CARD = 400;
/** How many nearby cards each card tries swapping places with. */
const PARTNERS = 8;

/**
 * Swaps the places of pairs of free cards while that leaves fewer lines
 * running through cards that are not theirs (shorter lines break ties). The
 * force layout only pulls neighbours together, so it leaves such lines behind;
 * a swap keeps every card on a spot already known to be clear, so nothing
 * overlaps afterwards. Positioned cards stay put. Deterministic.
 */
function untangle(
  ids: string[],
  edges: LayoutEdge[],
  points: Record<string, Point>,
  fixed: Set<string>,
) {
  const free = ids.flatMap((id, i) => (fixed.has(id) ? [] : [i]));
  if (free.length < 2) return;
  // Plain arrays by card number: this runs thousands of times.
  const index = new Map(ids.map((id, i) => [id, i]));
  const x = ids.map((id) => points[id]!.x);
  const y = ids.map((id) => points[id]!.y);
  const lines: [number, number][] = [];
  for (const edge of edges) {
    const from = index.get(edge.source);
    const to = index.get(edge.target);
    if (from !== undefined && to !== undefined && from !== to)
      lines.push([from, to]);
  }
  const touching = ids.map(() => [] as number[]);
  lines.forEach(([from, to], line) => {
    touching[from]!.push(line);
    touching[to]!.push(line);
  });
  const halfW = CARD_WIDTH / 2;
  const halfH = CARD_HEIGHT / 2;
  const through = (line: number, card: number) => {
    const [from, to] = lines[line]!;
    if (card === from || card === to) return false;
    // Most lines are nowhere near most cards: their boxes tell that cheaply.
    if (
      Math.max(x[from]!, x[to]!) <= x[card]! - halfW ||
      Math.min(x[from]!, x[to]!) >= x[card]! + halfW ||
      Math.max(y[from]!, y[to]!) <= y[card]! - halfH ||
      Math.min(y[from]!, y[to]!) >= y[card]! + halfH
    )
      return false;
    return segmentHitsRect(
      { x: x[from]!, y: y[from]! },
      { x: x[to]!, y: y[to]! },
      {
        x: x[card]! - halfW,
        y: y[card]! - halfH,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      },
    );
  };
  const stamp = new Int32Array(lines.length).fill(-1);
  let round = 0;
  // Cost of the lines a swap of `a` and `b` can change: theirs, and any other
  // line that may now run through either card.
  const local = (a: number, b: number) => {
    round++;
    let total = 0;
    for (const card of [a, b])
      for (const line of touching[card]!) {
        if (stamp[line] === round) continue;
        stamp[line] = round;
        for (let other = 0; other < ids.length; other++)
          if (through(line, other)) total += THROUGH_CARD;
        const [from, to] = lines[line]!;
        total += Math.hypot(x[to]! - x[from]!, y[to]! - y[from]!);
      }
    for (let line = 0; line < lines.length; line++) {
      if (stamp[line] === round) continue;
      if (through(line, a)) total += THROUGH_CARD;
      if (through(line, b)) total += THROUGH_CARD;
    }
    return total;
  };
  const swap = (a: number, b: number) => {
    [x[a], x[b]] = [x[b]!, x[a]!];
    [y[a], y[b]] = [y[b]!, y[a]!];
  };
  // Where a card wants to be is beside its neighbours: its swap partners are
  // the free cards sitting nearest their middle.
  const near = (a: number) => {
    const around = touching[a]!.map((line) => {
      const [from, to] = lines[line]!;
      return from === a ? to : from;
    });
    if (!around.length) return [];
    const mx = around.reduce((sum, card) => sum + x[card]!, 0) / around.length;
    const my = around.reduce((sum, card) => sum + y[card]!, 0) / around.length;
    return free
      .filter((card) => card !== a)
      .map((card) => ({ card, away: Math.hypot(x[card]! - mx, y[card]! - my) }))
      .sort((p, q) => p.away - q.away || p.card - q.card)
      .slice(0, PARTNERS)
      .map((each) => each.card);
  };
  // Cards worth moving: those a line runs through, or whose own lines run through a card.
  const troubled = () => {
    const bad = new Set<number>();
    for (let line = 0; line < lines.length; line++)
      for (let card = 0; card < ids.length; card++)
        if (through(line, card)) {
          bad.add(lines[line]![0]);
          bad.add(lines[line]![1]);
          bad.add(card);
        }
    return free.filter((card) => bad.has(card));
  };
  for (let sweep = 0; sweep < 6; sweep++) {
    let improved = false;
    for (const a of troubled()) {
      for (const b of near(a)) {
        const before = local(a, b);
        swap(a, b);
        if (local(a, b) < before - 1) improved = true;
        else swap(a, b);
      }
    }
    if (!improved) break;
  }
  ids.forEach((id, i) => {
    points[id] = { x: x[i]!, y: y[i]! };
  });
}

// A bounded force layout accepts cycles and leaves already positioned nodes fixed.
export function layoutContextGraph(
  request: LayoutRequest,
): Record<string, Point> {
  const ids = [...request.nodes].sort();
  const points: Record<string, Point> = {};
  const start = ringPlacement(ids, request.center);
  for (const id of ids) {
    const existing = request.positions[id];
    points[id] = existing ? { ...existing } : start[id]!;
  }
  const centered = request.center !== undefined;
  for (let iteration = 0; iteration < 100; iteration++) {
    const forces: Record<string, Point> = Object.fromEntries(
      ids.map((id) => [id, { x: 0, y: 0 }]),
    );
    // The grid already keeps cards apart, so with nothing central only the
    // connection pull runs; repulsion would spread a small map past the view.
    for (let i = 0; i < ids.length && centered; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = points[ids[i]!]!;
        const b = points[ids[j]!]!;
        let dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx === 0 && dy === 0) dx = 0.01;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const force = Math.min(10, 10000 / (distance * distance));
        forces[ids[i]!]!.x += (dx / distance) * force;
        forces[ids[i]!]!.y += (dy / distance) * force;
        forces[ids[j]!]!.x -= (dx / distance) * force;
        forces[ids[j]!]!.y -= (dy / distance) * force;
      }
    }
    for (const edge of request.edges) {
      const a = points[edge.source];
      const b = points[edge.target];
      if (!a || !b || edge.source === edge.target) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const ux = dx / distance;
      const uy = dy / distance;
      // Rest length: just far enough for the label and arrowhead between the cards.
      const rest = 2 * reach(ux, uy) + freeLength(edge.label, ux, uy) + 24;
      const force = Math.max(-5, Math.min(5, (distance - rest) * 0.02));
      forces[edge.source]!.x += (dx / distance) * force;
      forces[edge.source]!.y += (dy / distance) * force;
      forces[edge.target]!.x -= (dx / distance) * force;
      forces[edge.target]!.y -= (dy / distance) * force;
    }
    for (const id of ids) {
      if (request.positions[id] || id === request.center) continue;
      points[id]!.x += forces[id]!.x;
      points[id]!.y += forces[id]!.y;
    }
  }
  const fixed = new Set(
    ids.filter((id) => request.positions[id] || id === request.center),
  );
  separate(ids, points, fixed);
  settle(ids, points, fixed);
  untangle(ids, request.edges, points, fixed);
  // Cards pushed apart for a label can collide with others, and the reverse.
  for (let round = 0; round < 60; round++) {
    const spaced = spaceEdges(request.edges, points, fixed);
    const apart = separate(ids, points, fixed);
    if (!spaced && !apart) break;
  }
  return points;
}

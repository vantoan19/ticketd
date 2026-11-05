import type { Point } from "./context-layout";

export type Rect = { x: number; y: number; width: number; height: number };
export type Route = {
  /** Polyline from the source card's edge to the target card's edge. */
  points: Point[];
  /** Centre of the label, clear of every card and of labels placed before it. */
  label: Point;
};

const CLEARANCE = 14;

function inflate(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + 2 * by,
    height: rect.height + 2 * by,
  };
}

function centre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Where a line from the rect's middle toward `toward` leaves the rect. */
export function borderPoint(rect: Rect, toward: Point): Point {
  const c = centre(rect);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const scale = Math.min(
    dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy),
  );
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** Whether the segment passes through the inside of the rect (touching does not count). */
export function segmentHitsRect(a: Point, b: Point, rect: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clips: [number, number][] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.width - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.height - a.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      t0 = Math.max(t0, r);
    } else {
      if (r < t0) return false;
      t1 = Math.min(t1, r);
    }
  }
  return t1 - t0 > 1e-9;
}

function pathHits(points: Point[], rects: Rect[]): boolean {
  for (let i = 0; i < points.length - 1; i++)
    if (rects.some((rect) => segmentHitsRect(points[i]!, points[i + 1]!, rect)))
      return true;
  return false;
}

function length(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++)
    total += Math.hypot(
      points[i + 1]!.x - points[i]!.x,
      points[i + 1]!.y - points[i]!.y,
    );
  return total;
}

function corners(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

/** Between the cards' edges, aimed at the first and last waypoint (or each other). */
function ends(source: Rect, target: Rect, via: Point[]): Point[] {
  const first = via[0] ?? centre(target);
  const last = via[via.length - 1] ?? centre(source);
  return [borderPoint(source, first), ...via, borderPoint(target, last)];
}

/**
 * A line from `source` to `target` that goes straight when it can and otherwise
 * bends around the corners of the cards in its way, never through them.
 */
export function routeEdge(
  source: Rect,
  target: Rect,
  others: Rect[],
  clearance = CLEARANCE,
): Point[] {
  const blockers = others.map((rect) => inflate(rect, clearance));
  const straight = ends(source, target, []);
  if (!pathHits(straight, blockers)) return straight;
  const hit = blockers.filter((rect) => pathHits(straight, [rect]));
  const spots = hit.flatMap((rect) => corners(inflate(rect, 2)));
  let best: Point[] | undefined;
  const consider = (via: Point[]) => {
    const path = ends(source, target, via);
    if (pathHits(path, blockers)) return;
    if (!best || length(path) < length(best)) best = path;
  };
  for (const spot of spots) consider([spot]);
  if (!best)
    for (const a of spots) for (const b of spots) if (a !== b) consider([a, b]);
  return best ?? straight;
}

function pointAt(points: Point[], fraction: number): Point {
  const total = length(points);
  let left = total * fraction;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= span || i === points.length - 2)
      return span === 0
        ? a
        : {
            x: a.x + ((b.x - a.x) * left) / span,
            y: a.y + ((b.y - a.y) * left) / span,
          };
    left -= span;
  }
  return points[0]!;
}

function boundsOf(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

function overlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Gap kept between a label and any card or other label. */
const LABEL_GAP = 4;

/**
 * The spot on the line where a label of `size` goes. Every candidate is a point
 * of the line itself, so a label always sits on its own edge. The first choice
 * is the point nearest the middle where the label touches no card and none of
 * the `taken` labels (and stays inside `bounds` when given). When no point of
 * the line is free of cards, the label is drawn over the cards as an opaque pill
 * at the free point nearest the middle, rather than moved away from its line.
 */
export function placeLabel(
  points: Point[],
  size: { width: number; height: number },
  cards: Rect[],
  taken: Rect[] = [],
  bounds?: Rect,
): Point {
  const boxAt = (at: Point): Rect => ({
    x: at.x - size.width / 2,
    y: at.y - size.height / 2,
    width: size.width,
    height: size.height,
  });
  const avoidCards = cards.map((rect) => inflate(rect, LABEL_GAP));
  const clear = (at: Point, rects: Rect[]) => {
    const box = boxAt(at);
    return !rects.some((rect) => overlap(box, rect));
  };
  const inside = (at: Point) => {
    if (!bounds) return true;
    const box = boxAt(at);
    return (
      box.x >= bounds.x &&
      box.y >= bounds.y &&
      box.x + box.width <= bounds.x + bounds.width &&
      box.y + box.height <= bounds.y + bounds.height
    );
  };
  const fractions = Array.from({ length: 49 }, (_, i) => 0.02 + i * 0.02).sort(
    (a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5),
  );
  for (const fraction of fractions) {
    const at = pointAt(points, fraction);
    if (inside(at) && clear(at, [...avoidCards, ...taken])) return at;
  }
  // No point of the line is clear of the cards: the label rides on the line,
  // above the cards, at the point nearest the middle that misses other labels.
  let best = pointAt(points, 0.5);
  let least = Infinity;
  for (const fraction of fractions) {
    const at = pointAt(points, fraction);
    const box = boxAt(at);
    const covered = taken.reduce(
      (sum, rect) =>
        sum +
        Math.max(
          0,
          Math.min(box.x + box.width, rect.x + rect.width) -
            Math.max(box.x, rect.x),
        ) *
          Math.max(
            0,
            Math.min(box.y + box.height, rect.y + rect.height) -
              Math.max(box.y, rect.y),
          ),
      0,
    );
    if (covered < least) {
      least = covered;
      best = at;
    }
  }
  return best;
}

/** Rough pixel size of an edge label at the map's label font. */
export function labelSize(text: string): { width: number; height: number } {
  return { width: Math.round(text.length * 6.8 + 16), height: 18 };
}

/** Routes every edge around the cards and places each label clear of cards and earlier labels. */
export function routeAll(
  cards: Record<string, Rect>,
  edges: { id: string; source: string; target: string; label?: string }[],
): Record<string, Route> {
  const all = Object.values(cards);
  const bounds = all.length ? inflate(boundsOf(all), 40) : undefined;
  const taken: Rect[] = [];
  const routes: Record<string, Route> = {};
  for (const edge of edges) {
    const source = cards[edge.source];
    const target = cards[edge.target];
    if (!source || !target) continue;
    const others = all.filter((rect) => rect !== source && rect !== target);
    const points = routeEdge(source, target, others);
    const size = labelSize(edge.label ?? "");
    const label = placeLabel(points, size, all, taken, bounds);
    taken.push({
      x: label.x - size.width / 2,
      y: label.y - size.height / 2,
      width: size.width,
      height: size.height,
    });
    routes[edge.id] = { points, label };
  }
  return routes;
}

/** SVG path through the points with rounded bends. */
export function pathFor(points: Point[], radius = 10): string {
  if (points.length < 2) return "";
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const here = points[i]!;
    const next = points[i + 1]!;
    const inLen = Math.hypot(here.x - prev.x, here.y - prev.y);
    const outLen = Math.hypot(next.x - here.x, next.y - here.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const a = {
      x: here.x - ((here.x - prev.x) / inLen) * r,
      y: here.y - ((here.y - prev.y) / inLen) * r,
    };
    const b = {
      x: here.x + ((next.x - here.x) / outLen) * r,
      y: here.y + ((next.y - here.y) / outLen) * r,
    };
    d += ` L ${a.x} ${a.y} Q ${here.x} ${here.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${last.x} ${last.y}`;
}

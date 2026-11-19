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

/** True when the point lies strictly inside the rect. */
function inside(point: Point, rect: Rect): boolean {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}

/**
 * The shortest way from `from` to `to` that stays out of every blocker: A* over
 * the visibility graph of the blockers' corners. Visibility is checked lazily,
 * when a candidate leg is first taken off the queue, so the many corners that
 * the search never nears cost nothing. Returns the corners passed, in order, or
 * undefined when the ends are walled in.
 */
function detour(from: Point, to: Point, blockers: Rect[]): Point[] | undefined {
  const corner = blockers
    .flatMap((rect) => corners(inflate(rect, 2)))
    .filter((spot) => !blockers.some((rect) => inside(spot, rect)));
  const nodes = [from, ...corner, to];
  const goal = nodes.length - 1;
  const cost = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const best = new Array<number>(nodes.length).fill(Infinity);
  const before = new Array<number>(nodes.length).fill(-1);
  const done = new Array<boolean>(nodes.length).fill(false);
  // Binary min-heap of legs, ordered by cost so far plus the straight-line rest.
  type Leg = { node: number; parent: number; walked: number; rank: number };
  const heap: Leg[] = [];
  const push = (leg: Leg) => {
    heap.push(leg);
    for (let i = heap.length - 1; i > 0;) {
      const up = (i - 1) >> 1;
      if (heap[up]!.rank <= heap[i]!.rank) break;
      [heap[up], heap[i]] = [heap[i]!, heap[up]!];
      i = up;
    }
  };
  const pop = (): Leg | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (top && last && heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        let small = i;
        for (const child of [2 * i + 1, 2 * i + 2])
          if (child < heap.length && heap[child]!.rank < heap[small]!.rank)
            small = child;
        if (small === i) break;
        [heap[small], heap[i]] = [heap[i]!, heap[small]!];
        i = small;
      }
    }
    return top;
  };
  push({ node: 0, parent: -1, walked: 0, rank: cost(from, to) });
  for (let leg = pop(); leg; leg = pop()) {
    if (done[leg.node]) continue;
    if (
      leg.parent >= 0 &&
      pathHits([nodes[leg.parent]!, nodes[leg.node]!], blockers)
    )
      continue;
    done[leg.node] = true;
    best[leg.node] = leg.walked;
    before[leg.node] = leg.parent;
    if (leg.node === goal) break;
    for (let next = 1; next < nodes.length; next++) {
      if (done[next]) continue;
      const walked = leg.walked + cost(nodes[leg.node]!, nodes[next]!);
      if (walked >= best[next]!) continue;
      push({
        node: next,
        parent: leg.node,
        walked,
        rank: walked + cost(nodes[next]!, to),
      });
    }
  }
  if (!done[goal]) return undefined;
  const via: Point[] = [];
  for (let at = before[goal]!; at > 0; at = before[at]!)
    via.unshift(nodes[at]!);
  return via;
}

/**
 * A line from `source` to `target` that goes straight when it can and otherwise
 * takes the shortest way around the cards in its path, never through them.
 */
export function routeEdge(
  source: Rect,
  target: Rect,
  others: Rect[],
  clearance = CLEARANCE,
): Point[] {
  const straight = ends(source, target, []);
  // Where a card is walled in, the margin kept around the others shrinks until
  // a way out through the gaps opens; the line then runs closer to the cards.
  for (const margin of [clearance, clearance / 2, 0]) {
    const blockers = others.map((rect) => inflate(rect, margin));
    if (!pathHits(straight, blockers)) return straight;
    const via = detour(centre(source), centre(target), blockers);
    if (!via) continue;
    const path = ends(source, target, via);
    if (!pathHits(path, blockers)) return path;
  }
  return straight;
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

/** Area of `box` that the rects cover, counting overlaps between them twice. */
function coverage(box: Rect, rects: Rect[]): number {
  return rects.reduce(
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
}

/** A label centre keeps this far from a bend, past where the corner is rounded. */
const BEND_CLEAR = 12;
/** Half the box around an arrowhead's tip that labels keep clear. */
const ARROW_REACH = 9;
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
  // The line is drawn with rounded bends, so a label sits only on a straight
  // stretch: its centre is then exactly on the drawn line.
  const straight = (at: Point) =>
    points
      .slice(1, -1)
      .every((bend) => Math.hypot(bend.x - at.x, bend.y - at.y) >= BEND_CLEAR);
  // First choice keeps a gap around every card; failing that, a label may sit
  // right against one, as long as it covers nothing.
  for (const gap of [LABEL_GAP, 0]) {
    const avoid = [...cards.map((rect) => inflate(rect, gap)), ...taken];
    for (const fraction of fractions) {
      const at = pointAt(points, fraction);
      if (inside(at) && straight(at) && clear(at, avoid)) return at;
    }
  }
  // No point of the line is clear of the cards: the label rides on the line,
  // above the cards, at the point nearest the middle that misses other labels.
  let best = pointAt(points, 0.5);
  let least = Infinity;
  for (const fraction of fractions) {
    const at = pointAt(points, fraction);
    if (!straight(at)) continue;
    const box = boxAt(at);
    // Hiding another label loses its words; hiding part of a card does not.
    const covered = 20 * coverage(box, taken) + coverage(box, cards);
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

type EdgeSpec = { id: string; source: string; target: string; label?: string };

/** The line of every edge, bent around the cards in its way. Independent of labels. */
export function routePaths(
  cards: Record<string, Rect>,
  edges: EdgeSpec[],
): Record<string, Point[]> {
  const all = Object.values(cards);
  const paths: Record<string, Point[]> = {};
  for (const edge of edges) {
    const source = cards[edge.source];
    const target = cards[edge.target];
    if (!source || !target) continue;
    paths[edge.id] = routeEdge(
      source,
      target,
      all.filter((rect) => rect !== source && rect !== target),
    );
  }
  return paths;
}

/**
 * Places the label of every edge that has one, clear of cards, arrowheads and
 * earlier labels. An edge without a label reserves no room.
 */
export function placeLabels(
  cards: Record<string, Rect>,
  paths: Record<string, Point[]>,
  edges: EdgeSpec[],
): Record<string, Route> {
  const all = Object.values(cards);
  const bounds = all.length ? inflate(boundsOf(all), 40) : undefined;
  const taken: Rect[] = [];
  const routes: Record<string, Route> = {};
  // Every arrowhead stays visible: no label is placed over one.
  for (const points of Object.values(paths)) {
    const tip = points[points.length - 1]!;
    taken.push({
      x: tip.x - ARROW_REACH,
      y: tip.y - ARROW_REACH,
      width: 2 * ARROW_REACH,
      height: 2 * ARROW_REACH,
    });
  }
  // Longest labels first: they are the hardest to fit.
  const labelled = edges
    .filter((edge) => edge.label && paths[edge.id])
    .sort((a, b) => b.label!.length - a.label!.length);
  const spots: Record<string, Point> = {};
  for (const edge of labelled) {
    const size = labelSize(edge.label!);
    const label = placeLabel(paths[edge.id]!, size, all, taken, bounds);
    taken.push({
      x: label.x - size.width / 2,
      y: label.y - size.height / 2,
      width: size.width,
      height: size.height,
    });
    spots[edge.id] = label;
  }
  for (const edge of edges) {
    const points = paths[edge.id];
    if (points)
      routes[edge.id] = {
        points,
        label: spots[edge.id] ?? pointAt(points, 0.5),
      };
  }
  return routes;
}

/** Routes every edge around the cards and places each label clear of cards and other labels. */
export function routeAll(
  cards: Record<string, Rect>,
  edges: EdgeSpec[],
): Record<string, Route> {
  return placeLabels(cards, routePaths(cards, edges), edges);
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

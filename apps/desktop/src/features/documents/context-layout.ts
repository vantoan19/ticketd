export type Point = { x: number; y: number };
export type LayoutRequest = {
  nodes: string[];
  edges: { source: string; target: string }[];
  positions: Record<string, Point>;
  /** The item the map is about; it sits in the middle with the rest around it. */
  center?: string;
};

/** Card footprint the layout keeps clear, matching the rendered node size. */
export const CARD_WIDTH = 180;
export const CARD_HEIGHT = 72;
const GAP = 24;
const MID = { x: 400, y: 240 };

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
) {
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
    if (!moved) return;
  }
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
      const force = Math.max(-5, Math.min(5, (distance - 180) * 0.02));
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
  return points;
}

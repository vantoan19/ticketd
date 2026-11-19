import type { Ticket } from "@/lib/api/client";
import { flowOrder } from "./flow-order";
export type FlowTicket = Pick<
  Ticket,
  "reference" | "title" | "status" | "availability" | "prerequisites"
>;
const closed = new Set(["Done", "Canceled", "Duplicate"]);
/** Complete Plan membership is required: bounded graph pages cannot establish depth. */
export function planFlow<T extends FlowTicket>(members: T[]) {
  const open = members.filter((ticket) => !closed.has(ticket.status));
  const byRef = new Map(open.map((ticket) => [ticket.reference, ticket]));
  const depths = new Map<string, number>();
  const cycles = new Set<string>();
  // Strongly connected groups need their own explanation, including overlapping cycles.
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  function visit(reference: string) {
    const index = indices.size;
    indices.set(reference, index);
    low.set(reference, index);
    stack.push(reference);
    stacked.add(reference);
    for (const blocker of byRef.get(reference)?.prerequisites ?? []) {
      if (!blocker.unresolved || !byRef.has(blocker.reference)) continue;
      if (!indices.has(blocker.reference)) {
        visit(blocker.reference);
        low.set(
          reference,
          Math.min(low.get(reference)!, low.get(blocker.reference)!),
        );
      } else if (stacked.has(blocker.reference))
        low.set(
          reference,
          Math.min(low.get(reference)!, indices.get(blocker.reference)!),
        );
    }
    if (low.get(reference) !== index) return;
    const group: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member) {
        group.push(member);
        stacked.delete(member);
      }
    } while (member && member !== reference);
    if (
      group.length > 1 ||
      byRef
        .get(reference)
        ?.prerequisites.some(
          (blocker) => blocker.unresolved && blocker.reference === reference,
        )
    )
      group.forEach((member) => cycles.add(member));
  }
  for (const ticket of open)
    if (!indices.has(ticket.reference)) visit(ticket.reference);
  function depth(reference: string): number {
    if (!byRef.has(reference)) return 0;
    if (cycles.has(reference)) {
      depths.set(reference, Infinity);
      return Infinity;
    }
    const known = depths.get(reference);
    if (known !== undefined) return known;
    const blockers = byRef
      .get(reference)!
      .prerequisites.filter((item) => item.unresolved);
    const value = blockers.length
      ? 1 + Math.max(...blockers.map((item) => depth(item.reference)))
      : 0;
    depths.set(reference, value);
    return value;
  }
  for (const ticket of open) depth(ticket.reference);
  const ordered = flowOrder(open);
  const lanes = [0, 1, 2].map((lane) =>
    ordered.filter(
      (ticket) => Math.min(2, depths.get(ticket.reference) ?? 0) === lane,
    ),
  );
  const edges = open.flatMap((ticket) =>
    ticket.prerequisites
      .filter((blocker) => blocker.unresolved && byRef.has(blocker.reference))
      .map((blocker) => ({
        blocker: blocker.reference,
        dependent: ticket.reference,
      })),
  );
  // Canceled and Duplicate prerequisites stay unresolved (spec 4.5), but Flow
  // hides closed tickets, so name the status where the blocker is not on screen.
  function blockerName(blocker: T["prerequisites"][number]) {
    const notes = [
      ...(!members.some((member) => member.reference === blocker.reference)
        ? ["outside this Plan"]
        : []),
      ...(closed.has(blocker.status) ? [blocker.status] : []),
    ];
    return blocker.reference + (notes.length ? ` (${notes.join(", ")})` : "");
  }
  function reason(ticket: T) {
    const blockers = ticket.prerequisites.filter((item) => item.unresolved);
    if (blockers.length)
      return `Waits on ${blockers.map(blockerName).join(", ")}${cycles.has(ticket.reference) ? " (they block each other)" : ""}`;
    const dependents = edges
      .filter((edge) => edge.blocker === ticket.reference)
      .map((edge) => edge.dependent);
    return dependents.length
      ? `Blocks ${dependents.join(", ")}`
      : "No open blockers";
  }
  // Flow only draws lines that run to a later lane; the rest sit in one lane
  // (every ticket two or more steps from Now shares "Later") or form a cycle.
  const laneOf = new Map(
    lanes.flatMap((lane, index) =>
      lane.map((ticket) => [ticket.reference, index] as const),
    ),
  );
  const undrawn = edges.filter(
    (edge) => laneOf.get(edge.blocker)! >= laneOf.get(edge.dependent)!,
  ).length;
  return { lanes, edges, undrawn, reason };
}

/** A card's rectangle, in the Flow frame's coordinates. */
export type FlowBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};
export type FlowPoint = { x: number; y: number };

/** How far under the lowest card a link that skips a lane runs. */
const LANE_CLEARANCE = 6;
const CORNER_RADIUS = 8;

/**
 * The corners of a link from `source` to `target`, running right, when cards
 * of the lanes it skips (`between`) stand in its way: it leaves into the
 * gutter after the source's lane, runs under the lowest of those cards, and
 * rises in the gutter before the target's lane. Nothing is crossed. A link
 * with no card in its way returns null and is drawn as one curve.
 */
export function flowDetour(
  source: FlowBox,
  target: FlowBox,
  between: FlowBox[],
): FlowPoint[] | null {
  if (!between.length) return null;
  const sy = (source.top + source.bottom) / 2;
  const ty = (target.top + target.bottom) / 2;
  const under = Math.max(...between.map((box) => box.bottom)) + LANE_CLEARANCE;
  // Both ends already lie below every card in the way.
  if (sy >= under && ty >= under) return null;
  const first = (source.right + Math.min(...between.map((b) => b.left))) / 2;
  const last = (Math.max(...between.map((b) => b.right)) + target.left) / 2;
  return [
    { x: source.right, y: sy },
    { x: first, y: sy },
    { x: first, y: under },
    { x: last, y: under },
    { x: last, y: ty },
    { x: target.left, y: ty },
  ];
}

/** An SVG path through right-angled corners, each rounded. */
function roundedPath(points: FlowPoint[]) {
  const toward = (from: FlowPoint, to: FlowPoint, by: number) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return {
      x: from.x + ((to.x - from.x) / length) * by,
      y: from.y + ((to.y - from.y) / length) * by,
    };
  };
  const [start, ...rest] = points;
  let d = `M${start!.x} ${start!.y}`;
  rest.forEach((corner, index) => {
    const before = points[index]!;
    const after = rest[index + 1];
    if (!after) return void (d += ` L${corner.x} ${corner.y}`);
    const radius = (other: FlowPoint) =>
      Math.min(
        CORNER_RADIUS,
        Math.hypot(other.x - corner.x, other.y - corner.y) / 2,
      );
    const enter = toward(corner, before, radius(before));
    const leave = toward(corner, after, radius(after));
    d += ` L${enter.x} ${enter.y} Q${corner.x} ${corner.y} ${leave.x} ${leave.y}`;
  });
  return d;
}

/** The SVG path of one Flow link; `between` as for `flowDetour`. */
export function flowLinkPath(
  source: FlowBox,
  target: FlowBox,
  between: FlowBox[],
) {
  const detour = flowDetour(source, target, between);
  if (detour) return roundedPath(detour);
  const x = source.right;
  const y = (source.top + source.bottom) / 2;
  const tx = target.left;
  const ty = (target.top + target.bottom) / 2;
  return `M${x} ${y} C${x + 20} ${y} ${tx - 20} ${ty} ${tx} ${ty}`;
}

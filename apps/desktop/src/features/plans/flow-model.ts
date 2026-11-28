export { planFlow } from "./plan-work-model";
export type { PlanWorkTicket as FlowTicket } from "./plan-work-model";

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

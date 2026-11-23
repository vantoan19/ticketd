import { round, type Point } from "../art/geometry";

export type Leg = readonly [Point, Point, ...Point[]];
const slope = 1 / Math.sqrt(3);

/** Spend the available height on two 30-degree turns. In a narrow margin the
 * remainder becomes a stair flight between landings. The same points drive the
 * deck and its cart, in page coordinates independent of the viewport height. */
export function routeLeg(
  start: Point,
  end: Point,
  width: number,
  phone: boolean,
  passage?: Point,
): Leg {
  const [x, y] = start,
    [u, v] = end;
  if (v <= y) return [start, end];
  if (phone) {
    const edge = Math.min(19, x, u),
      a = y + Math.abs(edge - x) * slope,
      b = v - Math.abs(u - edge) * slope;
    return a < b ? [start, [edge, a], [edge, b], end] : [start, end];
  }
  const sign = u >= x ? 1 : -1,
    margin = Math.min(62, width * 0.047);
  const spare = Math.max(0, ((v - y) / slope - Math.abs(u - x)) / 2);
  const roomA = Math.max(0, sign > 0 ? x - margin : width - margin - x);
  const roomB = Math.max(0, sign > 0 ? width - margin - u : u - margin);
  // Along the central diagonal, moving the first turn by one unit shifts the
  // crossing by two. The first leg passes between the guide and its links.
  const firstTurn = passage
    ? ((passage[1] - y) / slope - sign * (passage[0] - x)) / 2
    : Math.max(spare - roomB, spare * 0.42);
  const a = Math.max(0, Math.min(roomA, spare, firstTurn));
  const b = Math.min(roomB, spare - a);
  const ax = x - sign * a,
    bx = u + sign * b,
    ay = y + a * slope,
    by = v - b * slope;
  const stairs = Math.max(0, by - ay - Math.abs(bx - ax) * slope);
  // When the right margin is tight, put the remaining stairs beyond the guide.
  return passage
    ? [start, [ax, ay], [bx, by - stairs], [bx, by], end]
    : [start, [ax, ay], [ax, ay + stairs], [bx, by], end];
}

export function linePath(points: readonly Point[]) {
  return points
    .map(([x, y], i) => (i ? "L" : "M") + round(x) + " " + round(y))
    .join("");
}

/** Every panel seam runs across the walkway, following the other ground axis. */
export function panelSeams(leg: Leg, half: number, spacing: number) {
  const paths: string[] = [];
  for (let i = 1; i < leg.length; i++) {
    const [x, y] = leg[i - 1]!,
      [u, v] = leg[i]!;
    const dx = u - x,
      dy = v - y,
      span = Math.hypot(dx, dy);
    const stairs = Math.abs(dx) < 1;
    const count = Math.floor(span / (stairs ? spacing * 0.34 : spacing));
    for (let j = 1; j <= count; j++) {
      const t = j / (count + 1),
        px = x + dx * t,
        py = y + dy * t;
      const tx = stairs ? half : half * 0.87,
        ty = stairs ? 0 : (dx * dy < 0 ? 1 : -1) * half * 0.5;
      paths.push(
        linePath([
          [px - tx, py - ty],
          [px + tx, py + ty],
        ]),
      );
    }
  }
  return paths.join("");
}

/** Keep bridge abutments clear of station approaches and the tight turns.
 * Their deck and railings follow the same ground axis as the road beneath. */
export function routeLegBridges(leg: Leg, phone: boolean) {
  const spans: { at: Point; axis: "x" | "y" }[] = [];
  for (let i = 1; i < leg.length; i++) {
    const [x, y] = leg[i - 1]!,
      [u, v] = leg[i]!;
    const length = Math.hypot(u - x, v - y);
    if (Math.abs(u - x) < 1 || length < (phone ? 100 : 188)) continue;
    const count = length > (phone ? 540 : 760) ? 2 : 1;
    for (let j = 1; j <= count; j++) {
      const t = j / (count + 1);
      spans.push({
        at: [x + (u - x) * t, y + (v - y) * t],
        axis: u >= x ? "x" : "y",
      });
    }
  }
  return spans;
}

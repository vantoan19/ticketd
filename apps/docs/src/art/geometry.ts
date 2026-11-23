/** Ground axes run at ±30 degrees to the horizontal. Height is vertical. */
export type Point = readonly [x: number, y: number];
export type Position = readonly [x: number, y: number, z: number];
export const cosine = Math.sqrt(3) / 2;

export function project([x, y, z]: Position): Point {
  return [(x - y) * cosine, (x + y) / 2 - z];
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function path(points: readonly Position[], closed = false): string {
  return (
    points
      .map((point, index) => {
        const [x, y] = project(point);
        return (index ? "L" : "M") + round(x) + " " + round(y);
      })
      .join("") + (closed ? "Z" : "")
  );
}

export function translate(point: Position): string {
  const [x, y] = project(point);
  return "translate(" + round(x) + " " + round(y) + ")";
}

/** Cut both families of grid lines at the edges of a convex horizontal floor.
 * Explicit endpoints also keep external SVG instances identical across engines. */
export function floorGrid(
  floor: readonly Position[],
  spacing: number,
): [Position, Position][] {
  if (floor.length < 3 || spacing <= 0) return [];
  const z = floor[0]![2];
  const segments: [Position, Position][] = [];
  for (const [axis, other] of [
    [0, 1],
    [1, 0],
  ] as const) {
    const coordinates = floor.map((point) => point[axis]);
    const min = Math.min(...coordinates),
      max = Math.max(...coordinates);
    for (let line = min + spacing; line < max; line += spacing) {
      const ends: number[] = [];
      floor.forEach((a, index) => {
        const b = floor[(index + 1) % floor.length]!;
        if (
          line < Math.min(a[axis], b[axis]) ||
          line >= Math.max(a[axis], b[axis])
        )
          return;
        const t = (line - a[axis]) / (b[axis] - a[axis]);
        ends.push(a[other] + t * (b[other] - a[other]));
      });
      if (ends.length !== 2) continue;
      const low = Math.min(...ends),
        high = Math.max(...ends);
      segments.push(
        axis === 0
          ? [
              [line, low, z],
              [line, high, z],
            ]
          : [
              [low, line, z],
              [high, line, z],
            ],
      );
    }
  }
  return segments;
}

export function floorRect(
  x: number,
  y: number,
  width: number,
  depth: number,
  z: number,
): Position[] {
  return [
    [x, y, z],
    [x + width, y, z],
    [x + width, y + depth, z],
    [x, y + depth, z],
  ];
}

/** Constant ground speed, including at the corner of a walkway. */
export function along(
  points: readonly [Point, ...Point[]],
  progress: number,
): Point {
  const lengths = points
    .slice(1)
    .map(([x, y], i) => Math.hypot(x - points[i]![0], y - points[i]![1]));
  let distance =
    Math.max(0, Math.min(1, progress)) * lengths.reduce((a, b) => a + b, 0);
  for (const [i, length] of lengths.entries()) {
    if (distance <= length && length > 0) {
      const a = points[i]!,
        b = points[i + 1]!;
      return [
        a[0] + ((b[0] - a[0]) * distance) / length,
        a[1] + ((b[1] - a[1]) * distance) / length,
      ];
    }
    distance -= length;
  }
  return points[points.length - 1]!;
}

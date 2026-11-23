import type { Position } from "./geometry.ts";
import { Line, Plate, paint } from "./primitives.tsx";
import { Beacon, Rail } from "./objects.tsx";

/** A replaceable span viewed along either ground axis. The centre of the deck
 * is its origin so it can be placed directly on a measured route segment. */
export function Bridge({ axis }: { axis: "x" | "y" }) {
  const point = (along: number, across: number, z: number): Position =>
    axis === "x" ? [along, across, z] : [across, along, z];
  function block(
    along: number,
    across: number,
    z: number,
    length: number,
    width: number,
    h: number,
    shadow = false,
  ) {
    const [x, y] = point(along, across, z);
    return (
      <Plate
        x={x}
        y={y}
        z={z}
        w={axis === "x" ? length : width}
        d={axis === "x" ? width : length}
        h={h}
        shadow={shadow}
      />
    );
  }
  return (
    <g>
      {[-43, 40].map((d) => (
        <g key={d}>
          {block(d - 4, -13, -21, 12, 26, 3, true)}
          {block(d, -10, -18, 5, 19, 13)}
          {block(d - 2, -12, -7, 9, 24, 3)}
        </g>
      ))}
      <Line
        points={[
          point(-40, 7, -15),
          point(-12, 7, -4),
          point(17, 7, -15),
          point(40, 7, -4),
        ]}
        weight="edge"
        color={paint.fine}
      />
      {block(-55, -12, -4, 110, 24, 4)}
      {[-52, -26, 0, 26, 52].map((s) => (
        <Line
          key={s}
          points={[point(s, -12, 0), point(s, 12, 0)]}
          weight="fine"
          color={paint.fine}
        />
      ))}
      <Line
        points={[point(-55, 0, 0), point(55, 0, 0)]}
        weight="fine"
        color={paint.blue}
        dash="5 7"
      />
      <Rail p={point(-49, -11, 0)} axis={axis} length={98} h={11} />
      <Rail p={point(-49, 11, 0)} axis={axis} length={98} h={9} />
      <Beacon p={point(-48, -13, 0)} h={13} />
    </g>
  );
}

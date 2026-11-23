import { path, type Position } from "./geometry.ts";
import { At, Grid, Line, paint, Plate } from "./primitives.tsx";
import { Beacon, Person, Rail, Walk } from "./objects.tsx";
import { ReviewDeck } from "./stations.tsx";

/** A broad loading floor beneath the display. Moving the four decks onto its
 * front half leaves every station visible behind a tablet-width monitor. */
export function TabletWorld() {
  const rim: Position[] = [
    [-222, 210, 0],
    [210, -222, 0],
    [268, -164, 0],
    [268, 186, 0],
    [186, 268, 0],
    [-163, 268, 0],
  ];
  const front: Position[] = [rim[2]!, rim[3]!, rim[4]!, rim[5]!, rim[0]!];
  return (
    <g id="tablet">
      <path
        d={path(
          rim.map(([x, y]) => [x + 7, y + 4, -7]),
          true,
        )}
        fill={paint.shadow}
      />
      <path
        d={path(
          [
            ...front,
            ...[...front].reverse().map(([x, y]): Position => [x, y, -9]),
          ],
          true,
        )}
        stroke={paint.ink}
        fill={paint.left}
        strokeWidth="var(--line-outline)"
      />
      <path
        d={path(rim, true)}
        fill={paint.top}
        stroke={paint.ink}
        strokeWidth="var(--line-outline)"
      />
      <Grid floor={rim} spacing={28} />
      {[-134, 128].map((x) => (
        <At key={x} p={[x, 12 - x, 0]}>
          <Plate x={-6} y={-6} w={18} d={16} h={3} shadow />
          <Plate z={3} w={7} d={5} h={43} />
          <Plate x={-1} y={-1} z={46} w={9} d={7} h={2} />
        </At>
      ))}
      <Walk p={[-144, 120, 0]} w={290} d={29} h={8} />
      <Walk p={[117, -143, 0]} w={29} d={263} h={8} axis="y" />
      <At p={[-163, 156, 1]}>
        <g transform="scale(.68)">
          <use href="#station-0" />
        </g>
      </At>
      <At p={[161, -161, 1]}>
        <g transform="scale(.68)">
          <ReviewDeck />
        </g>
      </At>
      <At p={[20, 36, 1]}>
        <g transform="scale(.43)">
          <use href="#station-3" />
        </g>
      </At>
      <At p={[-14, 163, 1]}>
        <g transform="scale(.67)">
          <use href="#station-1" />
        </g>
      </At>
      <At p={[157, -18, 1]}>
        <g transform="scale(.67)">
          <use href="#station-2" />
        </g>
      </At>
      <Rail p={[149, -66, 8]} length={64} axis="y" h={8} />
      <At p={[119, 149, 0]}>
        {[0, 1, 2].map((i) => (
          <Plate key={i} y={i * 4} w={27} d={4} h={7 - i * 2} />
        ))}
      </At>
      <Walk p={[119, 161, 0]} w={27} d={94} h={2} axis="y" />
      <Person p={[166, 202, 0]} />
      <Beacon p={[118, 239, 2]} h={11} />
      <Line
        points={[
          [268, 186, 0],
          [268, 186, -9],
        ]}
      />
      <Line
        points={[
          [186, 268, 0],
          [186, 268, -9],
        ]}
      />
    </g>
  );
}

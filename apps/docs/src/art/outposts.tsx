import { At, Dot, Label, Line, paint, Plate } from "./primitives.tsx";
import { Beacon, Rail, Terrace, Ticket, Walk } from "./objects.tsx";
import { path, type Position } from "./geometry.ts";

/** A second copy of the workspace with its raised display, hinge and key deck. */
export function SyncDesk() {
  const screen = (x: number, z: number): Position => [
    x,
    12 - (z - 5) * 0.15,
    z,
  ];
  const panel = (x: number, z: number, w: number, h: number) =>
    path(
      [screen(x, z), screen(x + w, z), screen(x + w, z + h), screen(x, z + h)],
      true,
    );
  return (
    <At p={[-555, 87, 2]}>
      <Terrace p={[0, 0, 0]} w={126} d={73} h={14} title="Workspace sync" />
      <At p={[17, 7, 14]}>
        <Plate w={76} d={45} h={3} shadow />
        <path
          d={panel(0, 4, 76, 45)}
          fill={paint.left}
          stroke={paint.ink}
          strokeWidth="var(--line-outline)"
        />
        <path
          d={panel(4, 8, 68, 37)}
          fill={paint.top}
          stroke={paint.ink}
          strokeWidth="var(--line-fine)"
        />
        {[8, 29, 50].map((x, i) => (
          <g key={x}>
            <Line points={[screen(x, 38), screen(x + 15, 38)]} weight="fine" />
            <path
              d={panel(x, 26, 16, 7)}
              fill={i === 1 ? paint.blue : paint.left}
              stroke={paint.ink}
              strokeWidth=".6"
            />
            {i !== 1 && (
              <path
                d={panel(x, 15, 16, 7)}
                fill={paint.left}
                stroke={paint.fine}
                strokeWidth=".6"
              />
            )}
          </g>
        ))}
        {[0, 1, 2].map((row) => (
          <g key={row}>
            {Array.from({ length: 8 }, (_, i) => (
              <path
                key={i}
                d={path(
                  [
                    [9 + i * 7, 16 + row * 4, 3],
                    [14 + i * 7, 16 + row * 4, 3],
                    [14 + i * 7, 18 + row * 4, 3],
                    [9 + i * 7, 18 + row * 4, 3],
                  ],
                  true,
                )}
                fill={paint.right}
              />
            ))}
          </g>
        ))}
        <path
          d={path(
            [
              [26, 32, 3],
              [48, 32, 3],
              [48, 40, 3],
              [26, 40, 3],
            ],
            true,
          )}
          fill={paint.left}
          stroke={paint.fine}
          strokeWidth=".7"
        />
      </At>
      <Beacon p={[106, 12, 14]} h={32} />
      <Dot p={[110, 50, 14]} />
    </At>
  );
}

/** Imported Issues enter the review deck over a trestle. */
export function IssueFeed() {
  return (
    <At p={[176, -507, 0]}>
      {[5, 62, 121].map((y) => (
        <g key={y}>
          <Plate x={0} y={y} w={32} d={12} h={3} />
          <Plate x={4} y={y + 3} z={3} w={5} d={5} h={57} />
          <Plate x={23} y={y + 3} z={3} w={5} d={5} h={57} />
          <Line
            points={[
              [5, y + 5, 18],
              [25, y + 5, 53],
              [5, y + 5, 53],
              [25, y + 5, 18],
            ]}
            weight="fine"
          />
        </g>
      ))}
      <Walk p={[-2, 0, 60]} w={38} d={138} h={6} axis="y" />
      <Rail p={[-2, 0, 66]} length={138} axis="y" h={8} />
      {[12, 62, 103].map((y, i) => (
        <Ticket
          key={y}
          p={[2, y, 66]}
          refId={["Issue", "PR", "Issue"][i]!}
          w={27}
          d={20}
        />
      ))}
      <Plate x={34} y={20} z={54} w={3} d={79} h={13}>
        <Label p={[37, 90, 58]} plane="right" size={8}>
          GitHub Issues
        </Label>
      </Plate>
    </At>
  );
}

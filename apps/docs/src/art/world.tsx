import { At, Grid, Line, Outline, paint, Plate } from "./primitives.tsx";
import {
  AgentCart,
  Beacon,
  Person,
  Rail,
  Terrace,
  Ticket,
  Walk,
} from "./objects.tsx";
import { ReviewDeck, StationModel } from "./stations.tsx";
import { stationNames } from "./world-layout.ts";
import { Bridge } from "./bridge.tsx";
import { PocketWorld } from "./pocket.tsx";
import { TabletWorld } from "./tablet.tsx";
import { DownloadModel, LedgerModel } from "./distribution.tsx";
import { WaysideModel } from "./waystations.tsx";
import { IssueFeed, SyncDesk } from "./outposts.tsx";
import { path, type Position } from "./geometry.ts";

function Ground() {
  const outline: Position[] = [
    [-379, 125, 0],
    [125, -379, 0],
    [312, -379, 0],
    [379, -312, 0],
    [379, 312, 0],
    [312, 379, 0],
    [-312, 379, 0],
    [-379, 312, 0],
  ];
  const walls = [
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 7],
  ];
  return (
    <g>
      <path
        d={path(
          outline.map(([x, y]) => [x + 9, y + 5, -8]),
          true,
        )}
        fill={paint.shadow}
      />
      {walls.map(([i, j]) => {
        const a = outline[i!]!,
          b = outline[j!]!;
        return (
          <path
            key={i}
            d={path([a, b, [b[0], b[1], -10], [a[0], a[1], -10]], true)}
            fill={i! < 5 ? paint.right : paint.left}
            stroke={paint.ink}
            strokeWidth="var(--line-outline)"
          />
        );
      })}
      <path
        d={path(outline, true)}
        fill={paint.top}
        stroke={paint.ink}
        strokeWidth="var(--line-outline)"
      />
      <Grid floor={outline} spacing={38} />
    </g>
  );
}

function DisplayFoot() {
  // A cross-section on x + y = 0 faces the reader squarely.
  return (
    <g>
      <g opacity="var(--display-stand, 0)">
        {[-255, 234].map((x) => (
          <g key={x} transform={`translate(${x})`}>
            <path d="M0 -68h20v66H0Z" fill={paint.left} stroke={paint.ink} />
            <path
              d="M20 -68l5 -4v66l-5 4Z"
              fill={paint.right}
              stroke={paint.ink}
            />
            <path
              d="M3 -6h13M3 -62h13"
              fill="none"
              stroke={paint.fine}
              strokeWidth="var(--line-fine)"
            />
          </g>
        ))}
      </g>
      <path d="M-374 -1H387L406 7H-358Z" fill={paint.shadow} />
      <path d="M-388 -8H376L388 -2H-376Z" fill={paint.top} stroke={paint.ink} />
      <path d="M-376 -2H388V4H-376Z" fill={paint.left} stroke={paint.ink} />
    </g>
  );
}

function Stairs() {
  return (
    <At p={[183, 215, 0]}>
      {Array.from({ length: 7 }, (_, i) => (
        <Plate key={i} y={i * 6} w={44} d={6} h={24 - i * 3} />
      ))}
    </At>
  );
}

export function MainWorld() {
  return (
    <g id="world">
      <Ground />
      <Line
        points={[
          [-445, 99, 40],
          [-380, 164, 4],
          [-330, 207, 9],
        ]}
        color={paint.blue}
        weight="fine"
        dash="4 4"
      />
      <SyncDesk />
      <IssueFeed />
      <Terrace p={[-218, -218, 0]} w={436} d={436} h={17} grid />
      <Walk p={[-218, -218, 17]} w={436} d={34} h={7} />
      <Walk p={[-218, -184, 17]} w={34} d={368} h={7} axis="y" />
      <Walk p={[184, -184, 17]} w={34} d={368} h={7} axis="y" />
      <Walk p={[-218, 184, 17]} w={436} d={34} h={7} />
      <At p={[-349, 206, 0]}>
        <use href="#station-0" />
      </At>
      <At p={[190, -317, 0]}>
        <ReviewDeck />
      </At>
      <DisplayFoot />
      <At p={[65, 65, 17]}>
        <Plate w={92} d={92} h={4} shadow>
          <Outline x={6} y={6} z={4} w={80} d={80} />
          <Outline x={22} y={22} z={4} w={48} d={48} />
          <Line
            points={[
              [30, 14, 4],
              [57, 14, 4],
              [52, 10, 4],
              [57, 14, 4],
              [52, 18, 4],
            ]}
            color={paint.blue}
          />
          <Line
            points={[
              [60, 78, 4],
              [36, 78, 4],
              [42, 74, 4],
              [36, 78, 4],
              [42, 82, 4],
            ]}
            color={paint.blue}
          />
        </Plate>
        <Plate x={65} y={63} z={4} w={15} d={12} h={6} tone="dark" />
        <Beacon p={[86, 7, 4]} h={18} />
      </At>
      <At p={[-65, 235, 0]}>
        <use href="#station-1" />
      </At>
      <At p={[231, -55, 0]}>
        <use href="#station-2" />
      </At>
      <Rail p={[218, -140, 24]} length={152} axis="y" />
      <Stairs />
      <Walk p={[183, 257, 0]} w={44} d={110} axis="y" h={3} />
      <Person p={[164, 321, 0]} />
      <Person p={[324, 189, 0]} />
    </g>
  );
}

export function Sprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg">
      <defs>
        <MainWorld />
        <g id="bridge-x">
          <Bridge axis="x" />
        </g>
        <g id="bridge-y">
          <Bridge axis="y" />
        </g>
        <TabletWorld />
        <PocketWorld />
        <DownloadModel />
        <LedgerModel />
        <g id="empty-cart">
          <AgentCart />
        </g>
        <g id="done-ticket">
          <Ticket refId="T-12" active w={40} d={27} />
        </g>
        {stationNames.map((name, i) => (
          <g key={name} id={"station-" + i}>
            <StationModel name={name} />
          </g>
        ))}
        {stationNames.map((name, i) => (
          <g key={name} id={"wayside-" + i}>
            <WaysideModel name={name} index={i} />
          </g>
        ))}
      </defs>
    </svg>
  );
}

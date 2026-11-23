import {
  At,
  Dot,
  Grid,
  Label,
  Line,
  Outline,
  paint,
  Plate,
} from "./primitives.tsx";
import { floorRect, path, type Position } from "./geometry.ts";

export function Ticket({
  p = [0, 0, 0],
  refId,
  active = false,
  w = 45,
  d = 30,
}: {
  p?: Position;
  refId: string;
  active?: boolean;
  w?: number;
  d?: number;
}) {
  const inset = Math.min(5, w * 0.1);
  const labelSize = Math.min(w / 4, (w - 2 * inset) / (refId.length * 0.62));
  return (
    <At p={p}>
      <Plate w={w} d={d} h={4} tone={active ? "blue" : "paper"} shadow>
        <Label
          p={[inset, d * 0.66, 4]}
          size={labelSize}
          color={active ? "var(--on-blue)" : paint.ink}
        >
          {refId}
        </Label>
        <Line
          points={[
            [4, 4, 4],
            [12, 4, 4],
          ]}
          weight="fine"
          color={active ? "var(--on-blue)" : paint.fine}
        />
        <Dot
          p={[w - 5, 5, 4]}
          r={1.5}
          fill={active ? "var(--on-blue)" : paint.ink}
        />
      </Plate>
    </At>
  );
}

export function Spec({
  p = [0, 0, 0],
  w = 92,
  h = 49,
  title = "Login hardening",
}: {
  p?: Position;
  w?: number;
  h?: number;
  title?: string;
}) {
  return (
    <At p={p}>
      <Plate x={-3} y={-2} w={w + 6} d={12} h={3} shadow />
      <Plate w={w} d={3} z={3} h={h} shadow>
        <Label p={[5, 3, h - 7]} size={w / 10.5} plane="left">
          {title}
        </Label>
        {[0.74, 0.85, 0.54, 0.65].map((f, i) => (
          <Line
            key={f}
            points={[
              [6, 3, h - 14 - i * 5],
              [w * f, 3, h - 14 - i * 5],
            ]}
            color={paint.fine}
            weight="fine"
          />
        ))}
        <Line
          points={[
            [w - 10, 3, h + 3],
            [w - 10, 3, h - 6],
            [w, 3, h - 6],
          ]}
          weight="fine"
        />
      </Plate>
    </At>
  );
}

export function Beacon({ p, h = 23 }: { p: Position; h?: number }) {
  return (
    <At p={p}>
      <Plate x={-1} y={-1} w={6} d={6} h={2} />
      <Plate z={2} w={4} d={4} h={h} shadow />
      <Plate x={-2} y={-2} z={h + 2} w={8} d={8} h={5} tone="blue" />
    </At>
  );
}

export function Person({ p }: { p: Position }) {
  return (
    <At p={p}>
      <path d="M0 0 7 1 9 3 2 3Z" fill={paint.shadow} />
      <path d="M-1.7 -6V0 M1.5 -6V0" stroke={paint.ink} strokeWidth="1.25" />
      <rect
        x="-2.8"
        y="-12"
        width="5.6"
        height="8"
        rx="1.5"
        fill={paint.left}
        stroke={paint.ink}
        strokeWidth="1"
      />
      <circle cx="0" cy="-15" r="2.2" fill={paint.ink} />
    </At>
  );
}

export function AgentCart({
  p = [0, 0, 0],
  label = "coding-agent",
}: {
  p?: Position;
  label?: string;
}) {
  return (
    <At p={p}>
      <Plate x={3} y={3} w={40} d={25} h={3} tone="dark" shadow />
      <Plate z={3} w={45} d={30} h={10} tone="dark" shadow>
        <Outline x={2} y={2} z={13} w={41} d={26} color={paint.fine} />
        <Label p={[4, 30, 5]} size={5.5} plane="left" color="var(--cart-label)">
          {label}
        </Label>
        {[5, 9, 13].map((y) => (
          <Line
            key={y}
            points={[
              [45, y, 5],
              [45, y + 1.8, 5],
            ]}
            color={paint.fine}
            weight="fine"
          />
        ))}
      </Plate>
      <Plate x={3} y={2} z={13} w={2} d={2} h={9} />
      <Plate x={2} y={1} z={22} w={4} d={4} h={3} tone="blue" />
    </At>
  );
}

export function Gate({
  p,
  w = 47,
  h = 30,
  label = "Review",
}: {
  p: Position;
  w?: number;
  h?: number;
  label?: string;
}) {
  return (
    <At p={p}>
      {[0, w - 3].map((x) => (
        <g key={x}>
          <Plate x={x - 2} y={-2} w={7} d={7} h={2} />
          <Plate x={x} w={3} d={3} z={2} h={h} />
        </g>
      ))}
      <Plate z={h} x={-2} y={-1} w={w + 4} d={5} h={12}>
        <Label p={[w / 2, 4, h + 3]} size={8.5} plane="left" anchor="middle">
          {label}
        </Label>
      </Plate>
    </At>
  );
}

export function Walk({
  p,
  w,
  d,
  h = 5,
  axis = "x",
  track = true,
}: {
  p: Position;
  w: number;
  d: number;
  h?: number;
  axis?: "x" | "y";
  track?: boolean;
}) {
  const span = axis === "x" ? w : d;
  const seams = [];
  for (let i = 17; i < span; i += 17)
    seams.push(
      path(
        axis === "x"
          ? [
              [i, 0, h],
              [i, d, h],
            ]
          : [
              [0, i, h],
              [w, i, h],
            ],
      ),
    );
  return (
    <At p={p}>
      <Plate w={w} d={d} h={h}>
        <path
          d={seams.join("")}
          stroke={paint.fine}
          strokeWidth="var(--line-fine)"
          fill="none"
        />
        {track && (
          <Line
            points={
              axis === "x"
                ? [
                    [0, d / 2, h],
                    [w, d / 2, h],
                  ]
                : [
                    [w / 2, 0, h],
                    [w / 2, d, h],
                  ]
            }
            color={paint.blue}
            weight="fine"
            dash="4 5"
          />
        )}
      </Plate>
    </At>
  );
}

export function Rail({
  p,
  length,
  axis = "x",
  h = 13,
}: {
  p: Position;
  length: number;
  axis?: "x" | "y";
  h?: number;
}) {
  const v = (d: number, z: number): Position =>
    axis === "x" ? [d, 0, z] : [0, d, z];
  const divisions = Math.max(1, Math.round(length / 26));
  return (
    <At p={p}>
      {Array.from({ length: divisions + 1 }, (_, i) => (
        <Line
          key={i}
          points={[
            v((i * length) / divisions, 0),
            v((i * length) / divisions, h),
          ]}
        />
      ))}
      <Line points={[v(0, h), v(length, h)]} />
      <Line
        points={[v(0, h * 0.6), v(length, h * 0.6)]}
        weight="fine"
        color={paint.fine}
      />
    </At>
  );
}

export function Terrace({
  p,
  w,
  d,
  h = 12,
  title,
  grid = false,
}: {
  p: Position;
  w: number;
  d: number;
  h?: number;
  title?: string;
  grid?: boolean;
}) {
  return (
    <At p={p}>
      <Plate w={w} d={d} h={h} shadow>
        {grid && <Grid floor={floorRect(0, 0, w, d, h)} />}
        {h > 6 && (
          <Line
            points={[
              [0, d, 3],
              [w, d, 3],
              [w, 0, 3],
            ]}
            color={paint.fine}
            weight="fine"
          />
        )}
        {title && (
          <Label
            p={[7, d, h * 0.26]}
            size={Math.min(h * 0.66, 12)}
            plane="left"
          >
            {title}
          </Label>
        )}
      </Plate>
    </At>
  );
}

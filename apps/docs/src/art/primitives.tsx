import type { ReactNode } from "react";
import {
  cosine,
  floorRect,
  floorGrid,
  path,
  project,
  round,
  translate,
  type Position,
} from "./geometry.ts";

export const paint = {
  top: "var(--face-top)",
  left: "var(--face-left)",
  right: "var(--face-right)",
  ink: "var(--drawing-ink)",
  fine: "var(--drawing-fine)",
  grid: "var(--drawing-grid)",
  blue: "var(--blue)",
  blueSide: "var(--blue-side)",
  blueTop: "var(--blue-top)",
  shadow: "var(--cast-shadow)",
  dark: "var(--cart-top)",
  darkSide: "var(--cart-side)",
};
type Tone = "paper" | "blue" | "dark";
const faces = {
  paper: [paint.top, paint.left, paint.right],
  blue: [paint.blueTop, paint.blue, paint.blueSide],
  dark: [paint.dark, paint.darkSide, paint.ink],
} as const;

export function At({ p, children }: { p: Position; children: ReactNode }) {
  return <g transform={translate(p)}>{children}</g>;
}

export function Line({
  points,
  color = paint.ink,
  weight = "edge",
  dash,
}: {
  points: readonly Position[];
  color?: string;
  weight?: "edge" | "fine" | "outline";
  dash?: string;
}) {
  return (
    <path
      d={path(points)}
      fill="none"
      stroke={color}
      strokeWidth={"var(--line-" + weight + ")"}
      strokeDasharray={dash}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  );
}

export function Plate({
  x = 0,
  y = 0,
  z = 0,
  w,
  d,
  h = 4,
  tone = "paper",
  shadow = false,
  children,
}: {
  x?: number;
  y?: number;
  z?: number;
  w: number;
  d: number;
  h?: number;
  tone?: Tone;
  shadow?: boolean;
  children?: ReactNode;
}) {
  const x1 = x + w,
    y1 = y + d,
    t = z + h;
  const a: Position = [x, y, t],
    b: Position = [x1, y, t],
    c: Position = [x1, y1, t],
    e: Position = [x, y1, t];
  const bottomC: Position = [x1, y1, z],
    bottomB: Position = [x1, y, z],
    bottomE: Position = [x, y1, z];
  const [top, left, right] = faces[tone];
  return (
    <g strokeLinejoin="round">
      {shadow && (
        <path
          fill={paint.shadow}
          d={path(
            [
              [x, y1, z],
              [x1, y1, z],
              [x1, y, z],
              [x1 + h * 0.55, y + h * 0.12, z],
              [x1 + h * 0.55, y1 + h * 0.12, z],
              [x + h * 0.55, y1 + h * 0.12, z],
            ],
            true,
          )}
        />
      )}
      <path d={path([a, b, c, e], true)} fill={top} />
      <path d={path([e, c, bottomC, bottomE], true)} fill={left} />
      <path d={path([b, bottomB, bottomC, c], true)} fill={right} />
      <Line points={[e, c, b]} weight="edge" />
      <Line points={[c, bottomC]} weight="edge" />
      <Line points={[a, b, bottomB, bottomC, bottomE, e, a]} weight="outline" />
      {children}
    </g>
  );
}

export function Label({
  p,
  children,
  size = 11,
  plane = "floor",
  color = paint.ink,
  anchor = "start",
}: {
  p: Position;
  children: ReactNode;
  size?: number;
  plane?: "floor" | "left" | "right" | "flat";
  color?: string;
  anchor?: "start" | "middle" | "end";
}) {
  const [x, y] = project(p);
  const axes =
    plane === "flat"
      ? "1 0 0 1"
      : plane === "floor"
        ? "0.866 0.5 -0.866 0.5"
        : plane === "left"
          ? "0.866 0.5 0 1"
          : "0.866 -0.5 0 1";
  return (
    <text
      transform={"matrix(" + axes + " " + round(x) + " " + round(y) + ")"}
      textAnchor={anchor}
      fontSize={size}
      fontFamily="ui-monospace, monospace"
      fontWeight="500"
      fill={color}
    >
      {children}
    </text>
  );
}

export function Dot({
  p,
  r = 2,
  fill = paint.blue,
}: {
  p: Position;
  r?: number;
  fill?: string;
}) {
  const [x, y] = project(p);
  return (
    <ellipse
      cx={round(x)}
      cy={round(y)}
      rx={round(r * cosine * Math.SQRT2)}
      ry={round(r * Math.SQRT1_2)}
      fill={fill}
    />
  );
}

export function Grid({
  floor,
  spacing = 28,
}: {
  floor: readonly Position[];
  spacing?: number;
}) {
  return (
    <path
      d={floorGrid(floor, spacing)
        .map((line) => path(line))
        .join("")}
      stroke={paint.grid}
      strokeWidth="var(--line-fine)"
      fill="none"
    />
  );
}

export function Outline({
  x = 0,
  y = 0,
  z,
  w,
  d,
  dash,
  color = paint.ink,
}: {
  x?: number;
  y?: number;
  z: number;
  w: number;
  d: number;
  dash?: string;
  color?: string;
}) {
  return (
    <path
      d={path(floorRect(x, y, w, d, z), true)}
      fill="none"
      stroke={color}
      strokeWidth="var(--line-fine)"
      strokeDasharray={dash}
    />
  );
}

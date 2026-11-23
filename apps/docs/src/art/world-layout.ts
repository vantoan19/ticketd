import { project, type Point, type Position } from "./geometry.ts";

export type Composition = "wide" | "tablet" | "pocket";
interface Scene {
  origin: Point;
  viewBox: string;
  scale: number;
  cartScale: number;
  deck: string;
  route: readonly Point[];
  done: Point;
  doneScale: number;
  exit: Point;
  ramp: readonly Point[];
  entry: Point;
  markers: readonly Position[];
}
const projected = (points: readonly Position[]) => points.map(project);
export const stationNames = ["Plan", "Hand off", "Follow", "Automate"] as const;
export const stationIds = ["plan", "hand-off", "follow", "automate"] as const;
export type Station = (typeof stationNames)[number];
export const stationStops = [0, 1, 3, 6] as const;
export const scenes: Record<Composition, Scene> = {
  wide: {
    origin: [720, 338],
    viewBox: "0 0 1440 751",
    scale: 1.1,
    cartScale: 1,
    deck: "world",
    done: project([280, -302, 25]),
    doneScale: 1,
    exit: project([205, 365, 3]),
    ramp: projected([
      [205, 218, 24],
      [205, 258, 3],
    ]),
    entry: project([254, -311, 13]),
    route: projected([
      [-225, 210, 22],
      [34, 185, 24],
      [185, 185, 24],
      [185, 31, 24],
      [185, -207, 24],
      [232, -243, 24],
    ]),
    markers: [
      [-282, 335, 0],
      [32, 348, 0],
      [341, 92, 0],
      [151, 166, 24],
    ],
  },
  tablet: {
    origin: [450, 72],
    viewBox: "0 0 900 343",
    scale: 1,
    cartScale: 0.71,
    deck: "tablet",
    done: project([221, -150, 18]),
    doneScale: 0.68,
    exit: project([132, 254, 2]),
    ramp: projected([
      [132, 149, 8],
      [132, 161, 2],
    ]),
    entry: project([191, -160, 9]),
    route: projected([
      [-140, 122, 8],
      [-18, 122, 8],
      [118, 122, 8],
      [118, 8, 8],
      [118, -143, 8],
      [159, -143, 8],
    ]),
    markers: [
      [-109, 235, 0],
      [26, 247, 0],
      [249, 67, 0],
      [81, 95, 0],
    ],
  },
  pocket: {
    origin: [210, 54],
    viewBox: "0 -42 420 227",
    scale: 1,
    cartScale: 0.6,
    deck: "pocket",
    done: project([70, -90, 12]),
    doneScale: 0.55,
    exit: project([64, 110, 1]),
    ramp: projected([
      [66, 81, 13],
      [66, 96, 2],
    ]),
    entry: project([75, -100, 2]),
    route: projected([
      [-76, 55, 13],
      [-8, 55, 13],
      [55, 55, 13],
      [55, 0, 13],
      [55, -48, 13],
      [59, -62, 13],
    ]),
    markers: [
      [-66, 92, 0],
      [20, 108, 0],
      [112, 16, 0],
      [40, 44, 14],
    ],
  },
};

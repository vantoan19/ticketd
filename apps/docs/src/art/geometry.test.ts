import { describe, expect, it } from "vitest";
import {
  along,
  cosine,
  floorRect,
  floorGrid,
  path,
  project,
  type Point,
} from "./geometry";
import { scenes, stationStops } from "./world-layout";
import { onWorld, carried } from "../demo/vehicle";
import { routeLeg } from "../journey/route";

describe("isometric geometry", () => {
  it("puts the ground axes at thirty degrees and height straight above the floor", () => {
    expect(project([10, 0, 4])).toEqual([10 * cosine, 1]);
    expect(project([0, 10, 4])).toEqual([-10 * cosine, 1]);
    expect(path(floorRect(0, 0, 8, 8, 0), true)).toBe(
      "M0 0L6.93 4L0 8L-6.93 4Z",
    );
  });
  it("stops floor grid lines on an angled perimeter in both directions", () => {
    expect(
      floorGrid(
        [
          [0, 0, 4],
          [12, 0, 4],
          [0, 12, 4],
        ],
        4,
      ),
    ).toEqual([
      [
        [4, 0, 4],
        [4, 8, 4],
      ],
      [
        [8, 0, 4],
        [8, 4, 4],
      ],
      [
        [0, 4, 4],
        [8, 4, 4],
      ],
      [
        [0, 8, 4],
        [4, 8, 4],
      ],
    ]);
  });
  it("travels at the same speed through a turn and stops at the route ends", () => {
    const way: readonly [Point, Point, Point, Point] = [
      [0, 0],
      [30, 0],
      [30, 0],
      [30, 10],
    ];
    expect(along(way, -0.2)).toEqual([0, 0]);
    expect(along(way, 0.75)).toEqual([30, 0]);
    expect(along(way, 0.875)).toEqual([30, 5]);
    expect(along(way, 2)).toEqual([30, 10]);
  });
  it("unloads at the review deck and leaves the cart parked as the ticket settles in Done", () => {
    for (const scene of Object.values(scenes)) {
      const parked = onWorld(scene, scene.route.length - 1);
      const delivered = onWorld(scene, stationStops[3]);
      expect(parked.ticket).toEqual(carried(parked.cart));
      expect(delivered.cart).toEqual(parked.cart);
      expect(delivered.ticket.position[0]).toBeCloseTo(scene.done[0]);
      expect(delivered.ticket.position[1]).toBeCloseTo(scene.done[1]);
      expect(delivered.ticket.scale).toBeCloseTo(scene.doneScale);
    }
  });
  it.each([1200, 850])(
    "routes through the guide opening at width %s",
    (width) => {
      const gate: Point = [470, 240];
      const leg = routeLeg([300, 100], [730, 680], width, false, gate);
      const next = leg.findIndex((at) => at[1] > gate[1]);
      const [x, y] = leg[next - 1]!;
      const [u, v] = leg[next]!;
      expect(x + ((gate[1] - y) * (u - x)) / (v - y)).toBeCloseTo(gate[0]);
    },
  );

  it.each([false, true])(
    "keeps a route connected to both station docks (narrow %s)",
    (narrow) => {
      const from: Point = [860, 0],
        to: Point = [340, 750],
        leg = routeLeg(from, to, 1200, narrow);
      expect(leg[0]).toEqual(from);
      expect(leg.at(-1)).toEqual(to);
      for (let i = 1; i < leg.length; i++) {
        const [x, y] = leg[i - 1]!,
          [u, v] = leg[i]!;
        expect(v).toBeGreaterThanOrEqual(y - 0.001);
        if (Math.abs(u - x) > 1)
          expect((v - y) / Math.abs(u - x)).toBeCloseTo(1 / Math.sqrt(3));
      }
    },
  );
});

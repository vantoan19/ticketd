import { along, type Point } from "../art/geometry";
import { scenes, type Composition } from "../art/world-layout";
import {
  carried,
  mix,
  offset,
  onWorld,
  transfer,
  wheelCentre,
  type Pose,
  type Scene,
  type VehiclePose,
} from "../demo/vehicle";
import type { Leg } from "./route";

export interface Dock {
  scene: Scene;
  origin: Point;
  scale: number;
  cart: SVGGElement;
  ticket: SVGGElement;
}

export function measureDock(anchor: Element, bounds: DOMRect): Dock | null {
  const svg = anchor.closest<SVGSVGElement>("svg[data-composition]");
  const deck = svg?.querySelector<SVGGElement>("[data-deck]")?.getScreenCTM();
  const cart = svg?.querySelector<SVGGElement>("[data-carriage]");
  const ticket = svg?.querySelector<SVGGElement>("[data-load]");
  if (!svg || !deck || !cart || !ticket) return null;
  return {
    scene: scenes[svg.dataset.composition as Composition],
    origin: [deck.e - bounds.left, deck.f - bounds.top],
    scale: deck.a,
    cart,
    ticket,
  };
}
function inStory(dock: Dock, pose: Pose): Pose {
  return {
    position: offset(dock.origin, pose.position, dock.scale),
    scale: pose.scale * dock.scale,
  };
}
function readLocal(element: SVGGElement): Pose {
  const transforms = element.transform.baseVal;
  const { e, f } = transforms.getItem(0).matrix;
  return { position: [e, f], scale: transforms.getItem(1).matrix.a };
}
function nearestEdge(points: readonly Point[], at: Point) {
  let nearest = 0,
    distance = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i - 1]!,
      [u, v] = points[i]!;
    const dx = u - x,
      dy = v - y;
    const p = Math.min(
      1,
      Math.max(
        0,
        ((at[0] - x) * dx + (at[1] - y) * dy) / (dx * dx + dy * dy || 1),
      ),
    );
    const d = Math.hypot(x + dx * p - at[0], y + dy * p - at[1]);
    if (d < distance) {
      nearest = i - 1;
      distance = d;
    }
  }
  return nearest;
}
function roadVehicle(centre: Point, scale: number): VehiclePose {
  const cart = { position: offset(centre, wheelCentre, -scale), scale };
  return { cart, ticket: carried(cart) };
}

/** Sample the current guide once when the visitor leaves it. Even mid-turn, the
 * scroll cart starts at the same point, takes the front stairs and joins the road. */
export function depart(dock: Dock, cruisingScale: number) {
  const { scene } = dock,
    local = readLocal(dock.cart);
  const cart = inStory(dock, local),
    ticket = inStory(dock, readLocal(dock.ticket));
  const corner = 2,
    edge = nearestEdge(scene.route, local.position);
  const toStairs =
    edge < corner
      ? scene.route.slice(edge + 1, corner + 1)
      : scene.route.slice(corner, edge + 1).reverse();
  const points: readonly [Point, ...Point[]] = [
    offset(cart.position, wheelCentre, cart.scale),
    ...toStairs.map((p) =>
      offset(dock.origin, offset(p, wheelCentre, scene.cartScale), dock.scale),
    ),
    ...scene.ramp.map((p) => offset(dock.origin, p, dock.scale)),
    offset(dock.origin, scene.exit, dock.scale),
  ];
  return (t: number): VehiclePose => {
    const pose = roadVehicle(
      along(points, t),
      mix(cart.scale, cruisingScale, t),
    );
    // A guide left at Done first collects the ticket from its stack.
    pose.ticket = transfer(
      ticket,
      pose.ticket,
      Math.min(1, t * 5),
      5 * dock.scale,
    );
    return pose;
  };
}
export function onRoad(leg: Leg, progress: number, scale: number) {
  return roadVehicle(along(leg, (progress - 0.12) / 0.76), scale);
}
export function arrive(
  dock: Dock,
  cruisingScale: number,
  t: number,
): VehiclePose {
  const parked = onWorld(dock.scene, dock.scene.route.length);
  const cart = inStory(dock, parked.cart),
    stack = inStory(dock, parked.ticket);
  const end = offset(cart.position, wheelCentre, cart.scale);
  const approach = Math.min(1, t / 0.63);
  const pose = roadVehicle(
    along([offset(dock.origin, dock.scene.entry, dock.scale), end], approach),
    mix(cruisingScale, cart.scale, approach),
  );
  pose.ticket = transfer(
    pose.ticket,
    stack,
    (t - 0.63) / 0.37,
    10 * dock.scale,
  );
  return pose;
}

import { project, type Point } from "../art/geometry";
import type { scenes } from "../art/world-layout";

export type Scene = (typeof scenes)[keyof typeof scenes];
export type Pose = { position: Point; scale: number };
export type VehiclePose = { cart: Pose; ticket: Pose };

/** Models are drawn from their back corner. The road passes under the centre of the wheels. */
export const wheelCentre = project([22, 15, 2]);
const loadOrigin = project([7, 4, 13]);

export function mix(from: number, to: number, t: number) {
  return from + (to - from) * t;
}
export function between(a: Point, b: Point, t: number): Point {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t)];
}
export function offset(origin: Point, by: Point, scale: number): Point {
  return [origin[0] + by[0] * scale, origin[1] + by[1] * scale];
}
export function carried(cart: Pose): Pose {
  return {
    position: offset(cart.position, loadOrigin, cart.scale),
    scale: cart.scale * 0.85,
  };
}
export function transfer(
  from: Pose,
  to: Pose,
  fraction: number,
  lift: number,
): Pose {
  const t = Math.min(1, Math.max(0, fraction));
  const [x, y] = between(from.position, to.position, t);
  return {
    position: [x, y - Math.sin(Math.PI * t) * lift],
    scale: mix(from.scale, to.scale, t),
  };
}

/** The last interval unloads the ticket onto the Done stack while the cart stays parked. */
export function onWorld(scene: Scene, cursor: number): VehiclePose {
  const last = scene.route.length - 1;
  const i = Math.min(Math.floor(cursor), last);
  const cart = {
    position: between(
      scene.route[i]!,
      scene.route[Math.min(i + 1, last)]!,
      Math.min(1, cursor - i),
    ),
    scale: scene.cartScale,
  };
  return {
    cart,
    ticket: transfer(
      carried(cart),
      { position: scene.done, scale: scene.doneScale },
      cursor - last,
      10 * scene.cartScale,
    ),
  };
}

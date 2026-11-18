import { m } from "motion/react";
import type { ComponentProps, ComponentType, ElementType } from "react";

/**
 * A scrolling list's component, made a `layoutScroll` host: pass `layoutScroll`
 * to the result. A Glide measures its old row against any scrolled ancestor
 * marked this way; without it the highlight starts off its old row once the
 * list has scrolled. Use it on every element that scrolls rows with a Glide.
 */
export function scrollHost<C extends ElementType>(Component: C) {
  // `m.create` types `style` as MotionStyle, which `exactOptionalPropertyTypes`
  // refuses for a component whose props say `CSSProperties | undefined`. The
  // props reach the component unchanged, so its own props type stands.
  return m.create(Component) as unknown as ComponentType<
    ComponentProps<C> & { layoutScroll: true }
  >;
}

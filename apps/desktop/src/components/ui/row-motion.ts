import {
  blur,
  enterTransition,
  exitTransition,
  rise,
  spring,
  staggerDelay,
  type SpringName,
} from "@/lib/motion-tokens";

// Appear's motion for a list item (DESIGN.md section 12). Appear itself is a
// div, and a list's item must be the li, so the same recipe is written once
// here as props for an `m.li`: fade up from a soft blur and settle, a stagger
// step behind `index`; leave faster; glide when a neighbour arrives or leaves.
// Timing comes from the motion tokens, read when a helper is called, so reduced
// motion and a held key reach every row; call it in render, never cache it.

/**
 * What a row's entrance or exit does besides fade. `space` opens (or closes) the
 * row's own height, as a created or trashed row does; a cascade leaves it out.
 * `gap` is a top margin that opens and closes with the row, for a group header.
 * `after` is seconds to wait before the cascade starts (the loading delay).
 */
type Shape = { space?: boolean; gap?: number | undefined; after?: number };

/** Fades up from a soft blur and settles, `index` stagger steps from the first. */
export function arrival(
  index = 0,
  { space = false, gap, after = 0 }: Shape = {},
) {
  const smooth = spring("smooth");
  // The wait sits inside each property's own transition: Motion reads a sibling
  // `delay` for none of them once `default` is present.
  const delay = after + staggerDelay(index);
  return {
    initial: {
      opacity: 0,
      y: rise("row"),
      filter: `blur(${blur("in")}px)`,
      ...(space && { height: 0, overflow: "clip" }),
      ...(gap !== undefined && { marginTop: space ? 0 : gap }),
    },
    animate: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      ...(space && { height: "auto" }),
      ...(gap !== undefined && { marginTop: gap }),
      // Once settled, drop the filter itself: a resting blur(0px) still keeps a
      // compositing layer on every row of a long list. The row's space stops
      // clipping, so what glides into it (the open row's highlight) is seen.
      transitionEnd: { filter: "none", ...(space && { overflow: "visible" }) },
      transition: {
        default: { ...enterTransition(), delay },
        y: { ...smooth, delay },
        height: { ...smooth, delay },
        marginTop: { ...smooth, delay },
      },
    },
  };
}

/** Fades out to a slight blur, faster than it arrived. */
export function departure({ space = false, gap }: Shape = {}) {
  const smooth = spring("smooth");
  return {
    exit: {
      opacity: 0,
      filter: `blur(${blur("out")}px)`,
      ...(space && { height: 0, overflow: "clip" }),
      ...(gap !== undefined && { marginTop: 0 }),
      transition: {
        default: exitTransition(),
        height: smooth,
        marginTop: smooth,
      },
    },
  };
}

/**
 * Moves to a new place on a spring instead of jumping. Pass `dependency`, a
 * value that changes only when the order does (the ids joined), so the row is
 * measured then and not on every render of its parent. A row held back and
 * released into a new group `travel`s farther.
 */
export function glide(dependency?: unknown, name: SpringName = "smooth") {
  return {
    layout: "position" as const,
    layoutDependency: dependency,
    transition: { layout: spring(name) },
  };
}

/**
 * Whether a page arrival is running (Shell marks the page root `data-arriving`).
 * Rows then arrive with the page, so a list's own cascade stays out of its way.
 * A held row's `li` carries the same attribute for its own fill; it is not a page.
 */
export function pageArriving(): boolean {
  return document.querySelector("[data-arriving]:not(li)") !== null;
}

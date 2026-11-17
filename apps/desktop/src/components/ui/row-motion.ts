import {
  blur,
  enterTransition,
  exitTransition,
  rise,
  spring,
  staggerDelay,
} from "@/lib/motion-tokens";

// Appear's motion for a list item (Appear itself is a div, and a list's item
// must be the li): fade up from a soft blur and settle, a stagger step behind
// `index`; leave faster; and glide when a neighbour arrives or leaves. Spread
// the result onto an `m.li`. Timing comes from the motion tokens, so reduced
// motion and a held key reach it like the rest.

/** Fades up from a soft blur and settles into place. */
export function arrival(index = 0) {
  return {
    initial: { opacity: 0, y: rise("row"), filter: `blur(${blur("in")}px)` },
    animate: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: {
        default: enterTransition(),
        y: spring("smooth"),
        delay: staggerDelay(index),
      },
    },
  };
}

/** Fades out to a slight blur, faster than it arrived. */
export function departure() {
  return {
    exit: {
      opacity: 0,
      filter: `blur(${blur("out")}px)`,
      transition: exitTransition(),
    },
  };
}

/** Moves to a new place on the smooth spring instead of jumping. */
export function glide() {
  return {
    layout: "position" as const,
    transition: { layout: spring("smooth") },
  };
}

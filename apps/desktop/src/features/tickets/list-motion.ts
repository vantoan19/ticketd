import {
  blur,
  enterTransition,
  exitTransition,
  rise,
  spring,
  staggerDelay,
} from "@/lib/motion-tokens";

/**
 * What a ticket row or board column does as it appears and leaves (DESIGN.md
 * section 12): it fades up from a soft blur and settles, and a row's space opens
 * on the smooth spring; leaving, it fades faster as its space closes. Every time
 * and distance is a token, read when this is called, so call it once per render
 * and share the result. `Appear` is a `div`; a `li` needs these as props.
 */
export function listMotion() {
  const smooth = spring("smooth");
  const enter = enterTransition();
  const hidden = {
    opacity: 0,
    y: rise("row"),
    filter: `blur(${blur("in")}px)`,
  };
  return {
    /** The spring a regrouped row glides on; a held row travels farther. */
    smooth,
    travel: spring("travel"),
    /** Where an entrance starts; `space` also starts it with no height. */
    initial: (space: boolean) => (space ? { ...hidden, height: 0 } : hidden),
    /** Where it settles; `index` places it in a cascade. */
    animate: (index: number, space: boolean) => ({
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      // Settled rows drop the filter itself: a resting blur(0px) still keeps a
      // compositing layer on every row of a long list.
      transitionEnd: { filter: "none" },
      ...(space && { height: "auto" }),
      transition: {
        default: enter,
        y: smooth,
        height: smooth,
        delay: staggerDelay(index),
      },
    }),
    /** Leaving: faster than the entrance, with the space closing behind it. */
    exit: {
      opacity: 0,
      height: 0,
      filter: `blur(${blur("out")}px)`,
      transition: { default: exitTransition(), height: smooth },
    },
  };
}

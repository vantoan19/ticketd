import { spring } from "@/lib/motion-tokens";

/** Zoom limits every graph shares. Fit never goes below 100%; the canvas pans. */
export const GRAPH_ZOOM = { min: 0.5, max: 2, fit: 1 } as const;

/**
 * How the view travels when the app moves it (focus, Fit, a card added out of
 * view): the smooth spring, in the milliseconds and plain function React Flow
 * takes. The tokens own the time and zero it under reduced motion and a held
 * key, so the view then jumps. Panning and zooming by hand never use it.
 */
export function graphGlide(): {
  duration: number;
  ease: (t: number) => number;
} {
  const { duration, ease } = spring("smooth");
  return {
    duration: duration * 1000,
    ease: typeof ease === "function" ? ease : (t) => t,
  };
}

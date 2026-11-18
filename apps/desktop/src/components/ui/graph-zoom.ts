import { useCallback, useEffect, useRef, useState } from "react";
import { spring } from "@/lib/motion-tokens";

/** Zoom limits every graph shares. Fit never goes below 100%; the canvas pans. */
export const GRAPH_ZOOM = { min: 0.5, max: 2, fit: 1 } as const;

export type GraphGlide = {
  duration: number;
  ease: (t: number) => number;
};

/**
 * How the view travels when the app moves it (focus, Fit, a card added out of
 * view): the smooth spring, in the milliseconds and plain function React Flow
 * takes. The tokens own the time and zero it under reduced motion and a held
 * key, so the view then jumps. Panning and zooming by hand never use it.
 */
function graphGlide(): GraphGlide {
  const { duration, ease } = spring("smooth");
  return {
    duration: duration * 1000,
    ease: typeof ease === "function" ? ease : (t) => t,
  };
}

/** How long past its duration a glide is given to report that it ended. */
const GLIDE_GRACE = 150;

/**
 * Moves the view with a glide that nothing cuts short.
 *
 * A canvas whose `viewport` is controlled hands React Flow the viewport state
 * back after every frame of a glide. That state is one render behind the glide,
 * so React Flow finds the view somewhere other than where it was told to be and
 * snaps it there, which ends the glide after a step. While `gliding` is true,
 * leave `viewport` out (`viewport={gliding ? undefined : viewport}`): React Flow
 * then draws the glide itself and `onViewportChange` still reports it, so the
 * state is current when the viewport is controlled again.
 *
 * `glide(move)` calls `move` with the glide's options and returns what `move`
 * returns, which settles when the view has arrived. A glide that jumps (reduced
 * motion, a held key) has nothing to protect. `stop` hands the viewport back
 * early, for a person's own pan or zoom.
 */
export function useViewportGlide(): {
  gliding: boolean;
  glide: (
    move: (options: GraphGlide) => Promise<unknown> | undefined,
  ) => Promise<unknown>;
  stop: () => void;
} {
  const [gliding, setGliding] = useState(false);
  const run = useRef(0);
  const grace = useRef(0);
  useEffect(() => () => window.clearTimeout(grace.current), []);
  const stop = useCallback(() => {
    run.current++;
    window.clearTimeout(grace.current);
    setGliding(false);
  }, []);
  const glide = useCallback(
    (move: (options: GraphGlide) => Promise<unknown> | undefined) => {
      const options = graphGlide();
      if (options.duration === 0) return Promise.resolve(move(options));
      const mine = ++run.current;
      const end = () => {
        if (run.current === mine) stop();
      };
      setGliding(true);
      // A glide another move or a person interrupts never reports its end.
      window.clearTimeout(grace.current);
      grace.current = window.setTimeout(end, options.duration + GLIDE_GRACE);
      const arrived = Promise.resolve(move(options));
      void arrived.then(end, end);
      return arrived;
    },
    [stop],
  );
  return { gliding, glide, stop };
}

import { useEffect, useState } from "react";
import { spring } from "@/lib/motion-tokens";

/**
 * What an `Expand` that comes and goes needs: whether to keep it mounted, and
 * whether it is open. It mounts closed and opens a frame later so the opening
 * is seen, and stays mounted until the closing has finished. Content that is
 * already there when it first renders simply is.
 */
export function useHeldExpand(open: boolean): {
  mounted: boolean;
  expanded: boolean;
} {
  const [phase, setPhase] = useState({ open, held: open, settled: open });
  // A change of `open` is applied while rendering, so the first frame of an
  // opening is already mounted (closed) and a closing starts at once.
  if (phase.open !== open)
    setPhase({ open, held: open || phase.held, settled: false });
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      setPhase((now) => ({ ...now, settled: true })),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (open) return;
    const closed = setTimeout(
      () => setPhase((now) => ({ ...now, held: false })),
      spring("smooth").duration * 1000,
    );
    return () => clearTimeout(closed);
  }, [open]);
  return { mounted: open || phase.held, expanded: open && phase.settled };
}

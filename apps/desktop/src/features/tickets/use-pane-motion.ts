import { useEffect, useState } from "react";
import { exitTransition, spring } from "@/lib/motion-tokens";

/** What the ticket panes show: nothing open, the list beside the document, or the document alone. */
export type PaneMode = "closed" | "split" | "expanded";

/** How the document arrives: opened, taken full width, or the list brought back. */
export type PaneArrival = "open" | "expand" | "return";

/** A pane that stays on screen for one exit after the layout dropped it. */
export type PaneLeaving = { pane: "detail" | "list"; from: PaneMode };

type Motion = { arrival: PaneArrival | null; leaving: PaneLeaving | null };

function change(from: PaneMode, to: PaneMode): Motion {
  if (from === "closed") return { arrival: "open", leaving: null };
  if (to === "closed")
    return { arrival: null, leaving: { pane: "detail", from } };
  if (to === "expanded")
    return { arrival: "expand", leaving: { pane: "list", from } };
  return { arrival: "return", leaving: null };
}

/**
 * The motion of the list and document panes (DESIGN.md section 5). The layout
 * changes at once; this says what plays on top of it: the `arrival` of the
 * document (or of the list coming back), and the pane that is still `leaving`
 * so it can fade out. Both end on their own after the time their token says,
 * so coming back to the Tickets view later does not play them again.
 *
 * Reduced motion and a held key zero those tokens: nothing arrives or leaves,
 * and no pane is kept on screen.
 */
export function usePaneMotion(mode: PaneMode): Motion {
  const [seen, setSeen] = useState(mode);
  const [arrival, setArrival] = useState<PaneArrival | null>(null);
  const [leaving, setLeaving] = useState<PaneLeaving | null>(null);
  if (seen !== mode) {
    setSeen(mode);
    const next = change(seen, mode);
    setArrival(spring("smooth").duration > 0 ? next.arrival : null);
    setLeaving(exitTransition().duration > 0 ? next.leaving : null);
  }
  useEffect(() => {
    if (!arrival) return;
    const timer = setTimeout(
      () => setArrival(null),
      spring("smooth").duration * 1000,
    );
    return () => clearTimeout(timer);
  }, [arrival]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(
      () => setLeaving(null),
      exitTransition().duration * 1000,
    );
    return () => clearTimeout(timer);
  }, [leaving]);
  return { arrival, leaving };
}

/**
 * What a pane showed before it started to leave. While `holding`, the pane
 * keeps showing it instead of the live values, so it fades out as it was
 * rather than as the empty state it would become.
 */
export function useHeld<T extends Record<string, unknown>>(
  live: T,
  holding: boolean,
): T {
  const [held, setHeld] = useState(live);
  if (
    !holding &&
    Object.keys(live).some((key) => !Object.is(held[key], live[key]))
  )
    setHeld(live);
  return holding ? held : live;
}

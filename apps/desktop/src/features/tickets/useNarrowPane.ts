import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { spring } from "@/lib/motion-tokens";
import { usePreferences } from "@/lib/preferences";

/** The ticket-detail container query's switch point: a 528px document column, so the text keeps about 480px, plus a 232px rail. */
const RAIL_MIN_WIDTH = 760;

/** How long the width must hold still before the layout follows it, while the sidebar's width spring runs. */
const SETTLE_MS = 120;

/**
 * Whether the pane is too narrow for the property rail, so it folds into chips.
 * A hidden pane (display: none) measures 0 and keeps its last layout, so the
 * rail and the drafts inside it are not remounted when the workspace is shown
 * again.
 *
 * The layout follows the width at once, except while the sidebar's width
 * spring runs: that sweeps the content panel through every width between the
 * two, and the layout must not flip halfway through the motion, so it waits
 * for the width to settle. A window edge being dragged, the first report, and
 * the first report after the pane was hidden are all followed at once.
 */
export function useNarrowPane(
  ref: RefObject<HTMLElement | null>,
  minWidth = RAIL_MIN_WIDTH,
  initiallyNarrow = false,
) {
  const [narrow, setNarrow] = useState(initiallyNarrow);
  // The sidebar folds or unfolds on its width spring; that is the only motion
  // of the panel's width the layout waits out.
  const { sidebarCollapsed } = usePreferences();
  const sweeping = useRef(false);
  const folded = useRef(sidebarCollapsed);
  useLayoutEffect(() => {
    if (folded.current === sidebarCollapsed) return;
    folded.current = sidebarCollapsed;
    sweeping.current = true;
    const done = setTimeout(
      () => (sweeping.current = false),
      spring("smooth").duration * 1000,
    );
    return () => clearTimeout(done);
  }, [sidebarCollapsed]);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const measure = (width: number) => {
      if (width > 0) setNarrow(width < minWidth);
    };
    measure(pane.clientWidth);
    let settle: ReturnType<typeof setTimeout> | undefined;
    // Nothing reported yet, or hidden at the last report: the next one is
    // taken as it stands.
    let last = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width } = entry.contentRect;
      const shown = last === 0;
      last = width;
      clearTimeout(settle);
      if (shown || !sweeping.current) measure(width);
      else settle = setTimeout(() => measure(width), SETTLE_MS);
    });
    observer.observe(pane);
    return () => {
      clearTimeout(settle);
      observer.disconnect();
    };
  }, [ref, minWidth]);
  return narrow;
}

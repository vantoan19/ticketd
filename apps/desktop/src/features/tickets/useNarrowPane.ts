import { useLayoutEffect, useState, type RefObject } from "react";

/** The ticket-detail container query's switch point: a 528px document column, so the text keeps about 480px, plus a 232px rail. */
const RAIL_MIN_WIDTH = 760;

/**
 * Whether the pane is too narrow for the property rail, so it folds into chips.
 * A hidden pane (display: none) measures 0 and keeps its last layout, so the
 * rail and the drafts inside it are not remounted when the workspace is shown
 * again.
 */
export function useNarrowPane(
  ref: RefObject<HTMLElement | null>,
  minWidth = RAIL_MIN_WIDTH,
) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const measure = (width: number) => {
      if (width > 0) setNarrow(width < minWidth);
    };
    measure(pane.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [ref, minWidth]);
  return narrow;
}

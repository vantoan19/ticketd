import { useEffect, useState, type RefObject } from "react";

/** The ticket-detail container query's switch point: a 420px document plus a 232px rail. */
const RAIL_MIN_WIDTH = 652;

/** Whether the pane is too narrow for the property rail, so it folds into chips. */
export function useNarrowPane(ref: RefObject<HTMLElement | null>) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const pane = ref.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < RAIL_MIN_WIDTH);
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

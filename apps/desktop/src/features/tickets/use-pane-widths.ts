import { useEffect, useRef, type RefObject } from "react";
import type { PaneMode } from "@/features/tickets/use-pane-motion";

/** The two panes' widths while they sit side by side, in pixels. */
export type PaneWidths = { list: number | null; detail: number | null };

/**
 * The width each pane had in the split, kept for the pane that leaves when the
 * split ends. The layout changes in the same commit that starts the exit, so by
 * then the pane's own width can no longer be read; this holds the last one the
 * browser reported while both were laid out beside each other.
 *
 * Observation is only on while `mode` is the split. A report that arrives after
 * the layout changed (the list taking the whole group, say) is not a width the
 * leaving pane ever had, so nothing is recorded outside the split.
 */
export function usePaneWidths(
  host: RefObject<HTMLElement | null>,
  mode: PaneMode,
): RefObject<PaneWidths> {
  const widths = useRef<PaneWidths>({ list: null, detail: null });
  const split = mode === "split";
  useEffect(() => {
    const element = host.current;
    if (!split || !element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const pane = entry.target.id;
        if (pane !== "list" && pane !== "detail") continue;
        widths.current[pane] =
          entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
      }
    });
    for (const id of ["list", "detail"]) {
      const pane = element.querySelector(`#${id}`);
      if (pane) observer.observe(pane);
    }
    return () => observer.disconnect();
  }, [host, split]);
  return widths;
}

import { useRef, type FocusEvent } from "react";

/** A press this soon after focus is one gesture (assistive technology focuses, then clicks). */
const SAME_GESTURE_MS = 150;

/**
 * Props factory for list row buttons that select an item. Focusing a row clipped by
 * the pane edge makes the browser scroll the whole pane to reveal it, which
 * moves the map and everything else. When the row is pressed as part of the same
 * gesture as its focus (keyboard-free selection, as assistive technology does),
 * the pane goes back to where it was; Tab navigation still reveals the row.
 */
export function useKeepPaneScroll() {
  const focused = useRef<{
    scroller: HTMLElement;
    top: number;
    at: number;
  } | null>(null);
  return (select: () => void) => ({
    onFocus(event: FocusEvent<HTMLElement>) {
      const scroller = event.currentTarget.closest<HTMLElement>(
        ".context-graph-page",
      );
      focused.current = scroller
        ? { scroller, top: scroller.scrollTop, at: performance.now() }
        : null;
    },
    onClick() {
      const at = focused.current;
      focused.current = null;
      select();
      if (!at || performance.now() - at.at > SAME_GESTURE_MS) return;
      const restore = () => {
        if (at.scroller.scrollTop !== at.top) at.scroller.scrollTop = at.top;
      };
      // The browser reveals the row once focus returns. Put the pane back as
      // each scroll happens, before it is painted, until the reveal is over.
      at.scroller.addEventListener("scroll", restore);
      restore();
      window.setTimeout(() => {
        at.scroller.removeEventListener("scroll", restore);
        restore();
      }, 300);
    },
  });
}

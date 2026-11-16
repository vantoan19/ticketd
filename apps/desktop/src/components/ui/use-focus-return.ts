import { useRef, type RefObject } from "react";

type AutoFocusHandler = (event: Event) => void;

/**
 * Radix returns focus on close only to a `Trigger` it rendered. Dialogs and
 * sheets here open from state, so they remember the element that had focus when
 * they opened and return to it, or to `returnTo` when the opener is gone (a
 * closed menu item, for example). A caller's own `onCloseAutoFocus` that
 * prevents the default wins.
 */
export function useFocusReturn(
  returnTo: RefObject<HTMLElement | null> | undefined,
  handlers: {
    onOpenAutoFocus?: AutoFocusHandler;
    onCloseAutoFocus?: AutoFocusHandler;
  },
  invocation?: HTMLElement | null,
  resolveReturnFocus?: () => HTMLElement | null,
) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus(event: Event) {
      const active = document.activeElement;
      opener.current =
        invocation ?? (active instanceof HTMLElement ? active : null);
      handlers.onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus(event: Event) {
      handlers.onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      const active = document.activeElement;
      // A new pane or overlay can take focus while this one's exit finishes.
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active.isConnected &&
        (!(event.target instanceof Node) || !event.target.contains(active))
      ) {
        event.preventDefault();
        return;
      }
      const target =
        resolveReturnFocus?.() ??
        returnTo?.current ??
        invocation ??
        opener.current;
      if (
        target?.isConnected &&
        target !== document.body &&
        !target.closest("[hidden], [inert]")
      ) {
        event.preventDefault();
        target.focus({ preventScroll: true });
      }
    },
  };
}

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

function available(element: HTMLElement) {
  // Layout effects can precede the closing sheet's inert observer.
  if (
    !element.isConnected ||
    element.closest(
      '[hidden], [inert], [data-slot="sheet-content"][data-state="closed"]',
    )
  )
    return false;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

/** Navigation is replaced, rather than hidden, when the narrow layout takes over. */
export function useResponsiveNavigationFocus(
  narrow: boolean,
  paletteReturnRef: RefObject<HTMLElement | null>,
) {
  const lastFocused = useRef<HTMLElement | null>(null);
  const navigationActions = useRef(new WeakMap<HTMLElement, string>());
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) {
        lastFocused.current = event.target;
        const action = event.target.closest<HTMLElement>(
          "[data-responsive-navigation]",
        )?.dataset.responsiveNavigation;
        if (action) navigationActions.current.set(event.target, action);
      }
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  const replacement = useCallback(
    (origin: HTMLElement | null) => {
      if (!origin || available(origin)) return origin;
      const action =
        navigationActions.current.get(origin) ??
        origin.dataset.responsiveNavigation;
      if (!action) return null;
      const find = (selector: string) =>
        [...document.querySelectorAll<HTMLElement>(selector)].find(available);
      const target = narrow
        ? find(
            `[data-responsive-navigation="${action === "search" ? "search" : "navigation"}"]`,
          )
        : action === "search"
          ? find('[data-responsive-navigation="search"]')
          : find(
              '[data-responsive-navigation="navigation"] [data-active="true"]',
            );
      return target ?? document.getElementById("main-content");
    },
    [narrow],
  );

  useLayoutEffect(() => {
    const origin = lastFocused.current;
    if (!origin || available(origin)) return;
    if (document.activeElement !== document.body) return;
    replacement(origin)?.focus({ preventScroll: true });
  }, [narrow, replacement]);

  return () => replacement(paletteReturnRef.current);
}

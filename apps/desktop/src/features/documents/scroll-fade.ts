import { useCallback, useRef } from "react";

/**
 * Marks a scroll container with `data-more-above` / `data-more-below` while
 * there is content cut off at that edge, so its stylesheet can fade just those
 * edges (a mask on the container itself, never a band painted over the content).
 * Returns a ref callback for the container.
 */
export function useScrollFade<T extends HTMLElement>() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((element: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!element) return;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = element;
      element.toggleAttribute("data-more-above", scrollTop > 1);
      element.toggleAttribute(
        "data-more-below",
        scrollHeight - clientHeight - scrollTop > 1,
      );
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    // Content added or removed changes the scrollable height without resizing the box.
    const mutations =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(update);
    mutations?.observe(element, { childList: true, subtree: true });
    cleanup.current = () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
      mutations?.disconnect();
    };
  }, []);
}

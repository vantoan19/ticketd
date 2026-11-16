import {
  useImperativeHandle,
  useLayoutEffect,
  useState,
  type Ref,
  type RefCallback,
} from "react";

/** Radix Presence keeps closed content mounted while its CSS exit runs. */
export function useClosingOverlayRef<T extends HTMLElement>(
  forwardedRef: Ref<T> | undefined,
): RefCallback<T> {
  const [element, setElement] = useState<T | null>(null);
  useImperativeHandle<T | null, T | null>(forwardedRef, () => element, [
    element,
  ]);
  useLayoutEffect(() => {
    if (!element) return;
    let pointerBeforeClose: string | null = null;
    const update = () => {
      const closed = element.dataset.state === "closed";
      element.toggleAttribute("inert", closed);
      // DismissableLayer writes this inline, above the shared CSS fallback.
      if (closed) {
        pointerBeforeClose ??= element.style.getPropertyValue("pointer-events");
        element.style.setProperty("pointer-events", "none");
      } else if (pointerBeforeClose !== null) {
        element.style.setProperty("pointer-events", pointerBeforeClose);
        pointerBeforeClose = null;
      }
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["data-state"],
    });
    return () => observer.disconnect();
  }, [element]);
  return setElement;
}

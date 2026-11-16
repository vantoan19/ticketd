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
    const update = () => {
      element.toggleAttribute("inert", element.dataset.state === "closed");
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

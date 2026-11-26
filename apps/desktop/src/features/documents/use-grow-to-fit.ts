import { useLayoutEffect, type RefObject } from "react";

/**
 * Sizes a text area to its whole text, so a wrapped value never hides a line. It follows the text
 * and the field's width (a narrower pane wraps more). `active` is false while the field is not
 * on the page.
 */
export function useGrowToFit(
  field: RefObject<HTMLTextAreaElement | null>,
  value: string,
  active: boolean,
) {
  useLayoutEffect(() => {
    const element = field.current;
    if (!active || !element) return;
    const fit = () => {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [field, value, active]);
}

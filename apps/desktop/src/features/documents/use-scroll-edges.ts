import { useEffect, useState, type RefObject } from "react";

/**
 * Which edges of `element` have more to scroll to: "top", "bottom", "both", or "" when it all
 * fits. The rail fades those edges, so a list that scrolls on its own says so.
 */
export function useScrollEdges(
  element: RefObject<HTMLElement | null>,
  items: number,
) {
  const [edges, setEdges] = useState("");
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      const above = node.scrollTop > 1;
      const below = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
      setEdges(above && below ? "both" : above ? "top" : below ? "bottom" : "");
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [element, items]);
  return edges;
}

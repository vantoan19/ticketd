import { useEffect, useState, type RefObject } from "react";

/**
 * How many times the element has come back into view after being hidden. The
 * app keeps some pages mounted behind `hidden`; use the count as a `key` to
 * play their entrance again each time they are opened. It stays 0 where the
 * page is never hidden, and without IntersectionObserver.
 */
export function useReopened(ref: RefObject<Element | null>): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    // null until the first report, so a page that starts visible is not "reopened".
    let shown: boolean | null = null;
    const observer = new IntersectionObserver((entries) => {
      const now = entries[entries.length - 1]?.isIntersecting ?? false;
      if (now && shown === false) setCount((value) => value + 1);
      shown = now;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return count;
}

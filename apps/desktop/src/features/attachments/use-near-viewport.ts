import { useEffect, useRef, useState } from "react";

/**
 * Whether an element has come within one screen of the viewport. It stays true
 * once it has, so a thumbnail that has loaded is never thrown away by scrolling
 * back. Without IntersectionObserver the element counts as near.
 */
export function useNearViewport<T extends Element>() {
  const ref = useRef<T>(null);
  const supported = typeof IntersectionObserver !== "undefined";
  const [near, setNear] = useState(!supported);
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near] as const;
}

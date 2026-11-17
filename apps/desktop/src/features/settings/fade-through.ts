import { useEffect, useState } from "react";
import { exitTransition } from "@/lib/motion-tokens";

/**
 * Follows `target` after the content has had time to fade out: `shown` is what
 * to render, `leaving` is true while the old content fades. With reduced
 * motion, a held key or rapid clicks the exit time is zero, so `shown` is the
 * target at once.
 */
export function useFadeThrough<T>(target: T): { shown: T; leaving: boolean } {
  const [shown, setShown] = useState(target);
  const wait = exitTransition().duration * 1000;
  if (shown !== target && !wait) setShown(target);
  const leaving = shown !== target && wait > 0;
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setShown(target), wait);
    return () => clearTimeout(timer);
  }, [leaving, target, wait]);
  return { shown: wait ? shown : target, leaving };
}

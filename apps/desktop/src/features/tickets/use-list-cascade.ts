import { useCallback, useEffect, useState } from "react";
import { loadingDelay } from "@/lib/motion-tokens";

/**
 * Whether the list's rows should fade up top first: when the list replaces the
 * Board, or replaces loading placeholders that were shown. A read that ended
 * inside the loading delay never showed any, so its rows just appear (or, at a
 * launch, arrive with the page). The cascade is one-shot. The list takes the
 * flag as it mounts and hands it back with `done`, so a row that arrives later
 * opens its own space instead of waiting behind the cascade.
 */
export function useListCascade(layout: "list" | "board", waiting: boolean) {
  const [seen, setSeen] = useState({ layout, waiting });
  const [cascade, setCascade] = useState(false);
  // True once a wait has lasted the loading delay: the placeholders are on show.
  const [shown, setShown] = useState(false);
  if (seen.layout !== layout || seen.waiting !== waiting) {
    setSeen({ layout, waiting });
    if (
      (seen.layout === "board" && layout === "list") ||
      (seen.waiting && !waiting && shown)
    )
      setCascade(true);
    if (!waiting) setShown(false);
  }
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setShown(true), loadingDelay() * 1000);
    return () => clearTimeout(timer);
  }, [waiting]);
  const done = useCallback(() => setCascade(false), []);
  return { cascade, done };
}

import { useCallback, useState } from "react";

/**
 * Whether the list's rows should fade up top first: when the list replaces the
 * Board, or replaces the loading placeholders. The cascade is one-shot. The list
 * takes the flag as it mounts and hands it back with `done`, so a row that
 * arrives later opens its own space instead of waiting behind the cascade.
 */
export function useListCascade(layout: "list" | "board", waiting: boolean) {
  const [seen, setSeen] = useState({ layout, waiting });
  const [cascade, setCascade] = useState(false);
  if (seen.layout !== layout || seen.waiting !== waiting) {
    setSeen({ layout, waiting });
    if (
      (seen.layout === "board" && layout === "list") ||
      (seen.waiting && !waiting)
    )
      setCascade(true);
  }
  const done = useCallback(() => setCascade(false), []);
  return { cascade, done };
}

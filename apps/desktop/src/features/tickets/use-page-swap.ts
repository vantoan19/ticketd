import { useEffect, useState } from "react";
import { exitTransition } from "@/lib/motion-tokens";

/**
 * Moving from one open ticket to another (J, K, or choosing another row): the
 * old document fades out where it was and the new one fades up after it
 * (DESIGN.md section 5). Opening from nothing and closing are not swaps; the
 * panes' own motion covers them.
 *
 * `swapped` stays true for the document now shown until the selection changes
 * again. `leaving` is the reference of the old document, for one exit; with
 * reduced motion or a held key the exit is zero and nothing is kept.
 */
export function usePageSwap(selected: string | null): {
  swapped: boolean;
  leaving: string | null;
} {
  const [seen, setSeen] = useState(selected);
  const [swapped, setSwapped] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  if (seen !== selected) {
    setSeen(selected);
    const swap = seen !== null && selected !== null;
    setSwapped(swap);
    setLeaving(swap && exitTransition().duration > 0 ? seen : null);
  }
  useEffect(() => {
    if (leaving === null) return;
    const timer = setTimeout(
      () => setLeaving(null),
      exitTransition().duration * 1000,
    );
    return () => clearTimeout(timer);
  }, [leaving]);
  return { swapped, leaving };
}

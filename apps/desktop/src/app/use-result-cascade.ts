import { useEffect, useRef, type RefObject } from "react";
import { arrive } from "@/components/layout/arrive";

/**
 * Typing in the command palette (DESIGN.md section 12): results that were not
 * there before settle in top first, a stagger step apart. A result already on
 * show stays still, so moving the highlight or a lookup finishing late never
 * replays the rest. The palette's own opening, and a list that returns when
 * the query is cleared, are not typing and do not cascade. A held key or
 * reduced motion makes `arrive` do nothing.
 */
export function useResultCascade(
  list: RefObject<HTMLElement | null>,
  typing: boolean,
) {
  const seen = useRef(new WeakSet<Element>());
  // After every render: results come from the query and from late lookups.
  useEffect(() => {
    let index = 0;
    for (const option of list.current?.querySelectorAll('[role="option"]') ??
      []) {
      if (seen.current.has(option)) continue;
      seen.current.add(option);
      if (typing) arrive(option, { index: index++ });
    }
  });
}

import { useEffect, useRef, useState } from "react";
import {
  currentHeading,
  type OutlineHeading,
} from "@/features/markdown/outline";

/** How far below the top of the column the reading line sits, in px. A heading brought to the top (24px) is above it. */
export const READING_LINE = 48;

/** The rendered heading with this anchor inside `scroller`. */
export function headingElement(
  scroller: ParentNode,
  id: string,
): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[id="${id}"]`);
}

/**
 * The current heading while `scroller` scrolls (the last heading above the
 * reading line), and `goTo`, which brings a heading to the top. Shared by every
 * view of the outline.
 *
 * A heading that was chosen counts as current at once and stays so on the way
 * there, so the outline does not flicker through the sections it passes. The
 * hold ends when the scroll arrives, ends, or the reader scrolls themselves.
 */
export function useCurrentHeading(
  scroller: HTMLElement | null,
  headings: readonly OutlineHeading[],
  /** Sections folded away: their headings are not on the page, and a fold moves the rest. */
  folded?: ReadonlySet<string>,
): { current: string | null; goTo: (id: string) => void } {
  const [live, setLive] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const held = useRef<string | null>(null);
  useEffect(() => {
    if (!scroller || headings.length === 0) return;
    const measure = () => {
      const top = scroller.getBoundingClientRect().top;
      const offsets = headings.map((heading) => {
        const element = headingElement(scroller, heading.id);
        return element && !element.closest("[hidden]")
          ? element.getBoundingClientRect().top - top
          : Number.POSITIVE_INFINITY;
      });
      const index = currentHeading(offsets, READING_LINE);
      const id = index === null ? null : (headings[index]?.id ?? null);
      setLive(id);
      if (held.current !== null && held.current === id) {
        held.current = null;
        setChosen(null);
      }
    };
    const release = () => {
      held.current = null;
      setChosen(null);
      measure();
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    scroller.addEventListener("scrollend", release);
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
      scroller.addEventListener(type, release, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", measure);
      scroller.removeEventListener("scrollend", release);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
        scroller.removeEventListener(type, release);
    };
  }, [scroller, headings, folded]);
  const goTo = (id: string) => {
    if (!scroller) return;
    held.current = id;
    setChosen(id);
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    headingElement(scroller, id)?.scrollIntoView({
      block: "start",
      behavior: reduced ? "auto" : "smooth",
    });
  };
  const current = chosen ?? live;
  return {
    current: headings.some((heading) => heading.id === current)
      ? current
      : (headings[0]?.id ?? null),
    goTo,
  };
}

import { useEffect, type RefObject } from "react";

/** Paint a sticky group's heading only after its section passes the scroll edge.
 * The attribute changes paint alone, keeping the heading and its rows in place.
 */
export function useStickyGroupHeadings(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const scroller = root.current;
    if (!scroller) return;
    const update = () => {
      const edge = scroller.getBoundingClientRect().top;
      for (const heading of scroller.querySelectorAll<HTMLElement>(
        "[data-sticky-group-heading]",
      )) {
        const section = heading.parentElement;
        heading.toggleAttribute(
          "data-stuck",
          !!section &&
            section.getBoundingClientRect().top < edge &&
            heading.getBoundingClientRect().top <= edge,
        );
      }
    };
    // Groups can appear or leave without a scroll event (an entry is read, a
    // group empties), which would leave a stale band on the wrong heading.
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        update();
      });
    };
    const content = new MutationObserver(schedule);
    content.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      content.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", update);
    };
  }, [root]);
}

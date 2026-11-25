import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * Whether something that has just finished stays open for now. A turn, or a stretch
 * of it, that ends while someone is reading it (`holds` says so, or focus is inside)
 * stays open until it has left the scroller's view, and only then folds, so nothing
 * the reader is looking at moves. What was already done when it first showed is
 * not kept. `done` says the work has ended; `element` is what folds.
 */
export function useKeptOpen(
  done: boolean,
  element: RefObject<HTMLElement | null>,
  holds: (element: HTMLElement, scroller: Element) => boolean,
): boolean {
  // `settled` says the end has been looked at; it starts true when there was no end to see.
  const [settled, setSettled] = useState(done);
  const [held, setHeld] = useState(false);
  const holding = useRef(holds);
  useLayoutEffect(() => {
    holding.current = holds;
  });
  useLayoutEffect(() => {
    if (!done || settled) return;
    const node = element.current;
    const scroller = node?.closest(".chat-scroll");
    const keep =
      node &&
      scroller &&
      (node.contains(document.activeElement) ||
        holding.current(node, scroller));
    setHeld(Boolean(keep));
    setSettled(true);
  }, [done, settled, element]);
  useEffect(() => {
    const node = element.current;
    const scroller = node?.closest(".chat-scroll");
    if (!held || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && !entry.isIntersecting) setHeld(false);
      },
      { root: scroller ?? null },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [held, element]);
  return !settled || held;
}

/** Whether any part of `node` is within the scroller's view. */
export function inView(node: Element, scroller: Element): boolean {
  const box = node.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return box.bottom > view.top && box.top < view.bottom;
}

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
 * the reader is looking at moves; it never folds around a focused control, but
 * waits until focus has left it. What was already done when it first showed is
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
    // Folding removes what is inside, so it waits while focus is in there: it
    // folds once the view has left it and focus has too, whichever comes last.
    let visible = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (!visible && !node.contains(document.activeElement)) setHeld(false);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        visible = entry.isIntersecting;
        release();
      },
      { root: scroller ?? null },
    );
    observer.observe(node);
    // After a focus move has landed: focus that only left the window is still inside.
    const left = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // The observer may not have reported the last scroll yet: read where it is now.
        if (scroller) visible = inView(node, scroller);
        release();
      }, 0);
    };
    node.addEventListener("focusout", left);
    return () => {
      clearTimeout(timer);
      node.removeEventListener("focusout", left);
      observer.disconnect();
    };
  }, [held, element]);
  return !settled || held;
}

/** Whether any part of `node` is within the scroller's view. */
export function inView(node: Element, scroller: Element): boolean {
  const box = node.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return box.bottom > view.top && box.top < view.bottom;
}

/** The nearest ancestor that actually scrolls: the document column, the rail,
 * or the whole detail when the rail sits below the document. */
function scrollParent(target: HTMLElement): HTMLElement | null {
  for (let node = target.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/** Reveal a target without moving the list, headers, or outer workspace. */
export function revealInDetail(target: HTMLElement) {
  const detail = target.closest<HTMLElement>(".detail-scroll");
  if (!detail) return;
  const scroller = scrollParent(target) ?? detail;
  const bounds = scroller.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  const centerOffset = Math.max(0, (scroller.clientHeight - item.height) / 2);
  scroller.scrollTop += item.top - bounds.top - centerOffset;
}

/** Reveal a target without moving the list, headers, or outer workspace. */
export function revealInDetail(target: HTMLElement) {
  const scroller = target.closest<HTMLElement>(".detail-scroll");
  if (!scroller) return;
  const bounds = scroller.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  const centerOffset = Math.max(0, (scroller.clientHeight - item.height) / 2);
  scroller.scrollTop += item.top - bounds.top - centerOffset;
}

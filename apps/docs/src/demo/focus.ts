/** Reveal a control in the embedded workspace while preserving the reader's page position. */
export function focusWorkspaceControl(
  control: HTMLElement,
  workspace: HTMLElement,
) {
  const strip = control.closest<HTMLElement>(".flow-strip");
  if (strip) strip.scrollLeft = control.offsetLeft - strip.clientLeft;

  for (
    let pane = control.parentElement;
    pane && pane !== workspace;
    pane = pane.parentElement
  ) {
    if (pane.scrollHeight <= pane.clientHeight) continue;
    if (!["auto", "scroll"].includes(getComputedStyle(pane).overflowY))
      continue;

    // Allow room for the two-pixel focus outline and its four-pixel offset.
    const edge = pane.getBoundingClientRect().top + pane.clientTop;
    const top = edge + 6,
      bottom = edge + pane.clientHeight - 6;
    const rect = control.getBoundingClientRect();
    if (rect.top < top) pane.scrollTop -= top - rect.top;
    else if (rect.bottom > bottom) pane.scrollTop += rect.bottom - bottom;
  }
  control.focus({ preventScroll: true });
}

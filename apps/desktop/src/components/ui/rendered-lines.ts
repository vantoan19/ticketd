/**
 * How many lines a clamped box holds once unclamped: its full height over its
 * line height. An inline chip (a mention) that pokes a pixel or two past its
 * line does not count as another line (chat CH-31).
 */
export function renderedLines(box: HTMLElement): number {
  const clamped = box.getAttribute("data-clamped");
  box.removeAttribute("data-clamped");
  const full = box.scrollHeight;
  if (clamped !== null) box.setAttribute("data-clamped", clamped);
  const line = parseFloat(getComputedStyle(box).lineHeight);
  return line > 0
    ? Math.round(full / line)
    : full > box.clientHeight + 1
      ? Infinity
      : 1;
}

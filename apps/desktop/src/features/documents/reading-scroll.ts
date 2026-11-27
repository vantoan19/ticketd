/** How the reader scrolls to a place on its own: smoothly, unless the person asked for less motion. */
export function readingScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

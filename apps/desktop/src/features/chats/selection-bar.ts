/** The Add to chat bar's height and the width kept clear for it. */
export const BAR_HEIGHT = 32;
const BAR_WIDTH = 132;
/** Space between the bar and the selected line. */
const GAP = 6;
/** Clearance from the window's edges. */
const EDGE = 16;

type Box = { left: number; top: number; bottom: number };

/**
 * Where the floating selection bar sits (P3): above the selection's first
 * line, starting where that line starts, so it never covers the line being
 * read. Only when there is no room above does it flip below the last line.
 * `side` is where the bar sits, and where its menu grows from, in place of
 * the bar.
 */
export function barPlacement(
  first: Box,
  last: Box,
  viewport: { width: number; height: number },
): { left: number; top: number; side: "top" | "bottom" } {
  const left = Math.max(
    EDGE,
    Math.min(first.left, viewport.width - BAR_WIDTH - EDGE),
  );
  const above = first.top - GAP - BAR_HEIGHT;
  if (above >= EDGE) return { left, top: above, side: "top" };
  return {
    left,
    top: Math.max(
      EDGE,
      Math.min(last.bottom + GAP, viewport.height - BAR_HEIGHT - EDGE),
    ),
    side: "bottom",
  };
}

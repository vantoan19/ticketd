import type { PdfPageSize } from "./pdf-document";

/** Space between pages, around the column, and under the last page for the view bar. */
export const PAGE_GAP = 16;
export const COLUMN_PADDING = 16;
export const BAR_CLEARANCE = 56;
/** Fit never enlarges a page past 125%. */
export const FIT_MAX = 1.25;
export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 3, 4,
] as const;
/** A canvas past this many pixels is drawn at a lower resolution instead. */
const MAX_CANVAS_PIXELS = 16_000_000;

/** The scale at which the widest page exactly fits `available` pixels, up to 125%. */
export function fitScale(pages: readonly PdfPageSize[], available: number) {
  const widest = Math.max(...pages.map((page) => page.width));
  return Math.min(FIT_MAX, Math.max(available / widest, ZOOM_STEPS[0]));
}

/** The next zoom step above or below `scale`. */
export function stepZoom(scale: number, direction: 1 | -1) {
  const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  const next = steps.find((step) =>
    direction > 0 ? step > scale + 0.005 : step < scale - 0.005,
  );
  return next ?? steps[steps.length - 1]!;
}

/** Where each page sits in the column, in pixels from the top of its content. */
export function pageTops(pages: readonly PdfPageSize[], scale: number) {
  let top = COLUMN_PADDING;
  const tops: number[] = [];
  const heights: number[] = [];
  for (const page of pages) {
    const height = Math.round(page.height * scale);
    tops.push(top);
    heights.push(height);
    top += height + PAGE_GAP;
  }
  return {
    tops,
    heights,
    total: top - PAGE_GAP + COLUMN_PADDING + BAR_CLEARANCE,
  };
}

/** The page that fills most of the view, as an index. */
export function pageInView(
  tops: readonly number[],
  heights: readonly number[],
  viewTop: number,
  viewHeight: number,
) {
  let best = 0;
  let most = -Infinity;
  const viewBottom = viewTop + viewHeight;
  for (let index = 0; index < tops.length; index += 1) {
    const top = tops[index]!;
    if (top > viewBottom) break;
    const shown =
      Math.min(viewBottom, top + heights[index]!) - Math.max(viewTop, top);
    if (shown > most) {
      most = shown;
      best = index;
    }
  }
  return best;
}

/** Pixels per CSS pixel to draw a page at, so a huge one stays within memory. */
export function outputScale(page: PdfPageSize, scale: number, density: number) {
  const area = page.width * scale * (page.height * scale);
  return Math.min(density, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(area, 1)));
}

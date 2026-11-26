import { expect, test } from "vitest";
import {
  BAR_CLEARANCE,
  COLUMN_PADDING,
  PAGE_GAP,
  fitScale,
  outputScale,
  pageInView,
  pageTops,
  stepZoom,
} from "./pdf-layout";

const letter = { width: 612, height: 792 };

test("Fit fits the widest page to the width and never past 125%", () => {
  expect(fitScale([letter, { width: 1224, height: 792 }], 612)).toBe(0.5);
  expect(fitScale([letter], 5000)).toBe(1.25);
  // A sliver of a window still gives a drawable page.
  expect(fitScale([letter], 10)).toBe(0.25);
});

test("zoom steps move to the next level in either direction and stop at the ends", () => {
  expect(stepZoom(1.25, 1)).toBe(1.5);
  expect(stepZoom(1.25, -1)).toBe(1.1);
  // A fitted scale between two levels goes to the nearer level on its side.
  expect(stepZoom(0.834, 1)).toBe(0.9);
  expect(stepZoom(0.834, -1)).toBe(0.8);
  expect(stepZoom(4, 1)).toBe(4);
  expect(stepZoom(0.25, -1)).toBe(0.25);
});

test("pages stack 16px apart and the column leaves room for the bar", () => {
  const { tops, heights, total } = pageTops([letter, letter, letter], 0.5);
  expect(heights).toEqual([396, 396, 396]);
  expect(tops).toEqual([16, 428, 840]);
  expect(total).toBe(
    COLUMN_PADDING + 3 * 396 + 2 * PAGE_GAP + COLUMN_PADDING + BAR_CLEARANCE,
  );
});

test("the page that fills most of the view is the current one", () => {
  const { tops, heights } = pageTops(Array(5).fill(letter), 1);
  // Top of the document: page 1.
  expect(pageInView(tops, heights, 0, 600)).toBe(0);
  // Page 2 starts at 824; a view from 700 shows 124px of page 1 and 476 of page 2.
  expect(pageInView(tops, heights, 700, 600)).toBe(1);
  // Past the end still names the last page.
  expect(pageInView(tops, heights, 99999, 600)).toBe(4);
});

test("a huge page is drawn at a lower resolution, an ordinary one at the screen's", () => {
  expect(outputScale(letter, 1, 2)).toBe(2);
  const poster = { width: 6000, height: 8000 };
  expect(outputScale(poster, 1, 2)).toBeLessThan(1);
});

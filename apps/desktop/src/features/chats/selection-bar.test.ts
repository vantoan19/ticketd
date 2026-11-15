import { expect, test } from "vitest";
import { barPlacement } from "@/features/chats/selection-bar";

const viewport = { width: 1280, height: 800 };

test("the bar sits above the selection's first line, where that line starts", () => {
  // Shell SH-18: it sat below the selection's end and covered the next line.
  const first = { left: 300, top: 400, bottom: 420 };
  const last = { left: 300, top: 440, bottom: 460 };
  expect(barPlacement(first, last, viewport)).toEqual({
    left: 300,
    top: 362,
    side: "top",
  });
});

test("without room above, the bar flips below the last line", () => {
  const first = { left: 300, top: 30, bottom: 50 };
  const last = { left: 300, top: 70, bottom: 90 };
  expect(barPlacement(first, last, viewport)).toEqual({
    left: 300,
    top: 96,
    side: "bottom",
  });
});

test("the bar stays 16px inside the window's edges", () => {
  const line = { left: 1270, top: 400, bottom: 420 };
  expect(barPlacement(line, line, viewport).left).toBe(1280 - 132 - 16);
});

import { expect, test } from "vitest";
import { fitTitle } from "./file-name";

// One unit a character: easy to reason about widths.
const measure = (text: string) => text.length;

test("a header name that fits is shown whole", () => {
  expect(fitTitle("refund.png", 40, measure)).toEqual({
    text: "refund.png",
    cut: false,
  });
});

test("a longer name gives way in the middle and keeps its end and extension", () => {
  const name = "refund-flow-recording-before-the-fix-and-after-the-fix.mov";
  const fitted = fitTitle(name, 30, measure);
  expect(fitted.cut).toBe(true);
  expect(fitted.text.length).toBeLessThanOrEqual(30);
  expect(fitted.text.startsWith("refund-flow")).toBe(true);
  expect(fitted.text.endsWith(name.slice(-14))).toBe(true);
  expect(fitted.text).toContain("…");
});

test("an unmeasured header (no width yet) is left alone", () => {
  expect(fitTitle("a-very-long-name.log", 0, measure).cut).toBe(false);
});

import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { breakable, fitName, fitTitle } from "./file-name";

// Just over seven pixels a letter: 21 letters fit the 154px a line of the card allows.
const measure = (text: string) => text.length * 7.3;

test("the extension stays with the words before it, never alone on a line", () => {
  // The browser may break after "-", "_" and ".", but not before the extension.
  expect(renderToStaticMarkup(breakable("e2e-run-2026-11-25.log"))).toBe(
    "e2e-<wbr/>run-<wbr/>2026-<wbr/>11-<wbr/>25.log",
  );
  expect(renderToStaticMarkup(breakable("archive.tar.gz"))).toBe(
    "archive.<wbr/>tar.gz",
  );
  // A name ending in a dot has no extension to keep.
  expect(renderToStaticMarkup(breakable("notes."))).toBe("notes.");
});

test("a cut keeps whole words at both ends of the cut", () => {
  const name = "PSP Refunds API v3 — partial captures (signed).pdf";
  const [first, second] = fitName(name, measure).lines!;
  expect(first).toBe("PSP Refunds API v3 — ");
  // "(signed).pdf" is kept whole; the head stops at a word, not mid-word.
  expect(second).toBe("partial…(signed).pdf");
  const dated = fitName(
    "load-test-results-2026-11-25-checkout-captures.html",
    measure,
  );
  expect(dated.lines![0]).toBe("load-test-results-");
  expect(dated.lines![1]).toBe("2026…captures.html");
});

test("a word longer than the kept end keeps its last characters", () => {
  const name = "a".repeat(60) + ".png";
  const fitted = fitName(name, measure);
  expect(fitted.cut).toBe(true);
  expect(fitted.text.endsWith(name.slice(-14))).toBe(true);
});

test("unmeasured, a cut name still ends at a whole word", () => {
  const fitted = fitName(
    "PSP Refunds API v3 — partial captures (signed).pdf",
    null,
  );
  expect(fitted.cut).toBe(true);
  expect(fitted.text.endsWith("…(signed).pdf")).toBe(true);
});

test("unmeasured, a cut never ends the prefix inside an emoji", () => {
  const fitted = fitName(`${"🎉".repeat(30)}.png`, null);
  expect(fitted.cut).toBe(true);
  expect(fitted.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("a wide script keeps its end inside the second line, taken from that line", () => {
  // Every character is 14 wide, so 14 of them overflow a 154px line.
  const wide = (text: string) => [...text].length * 14;
  const name = "退款流程修复前后的完整录屏记录文件第一份第二份第三份最终版.mov";
  const fitted = fitName(name, wide);
  const [first, second] = fitted.lines!;
  const end = second!.split("…")[1]!;
  expect(fitted.cut).toBe(true);
  expect(wide(second!)).toBeLessThanOrEqual(154);
  expect(name.startsWith(first!)).toBe(true);
  expect(name.endsWith(end)).toBe(true);
  expect(end.endsWith(".mov")).toBe(true);
  // The end comes from after line one, so nothing is shown twice.
  expect(name.length - first!.length).toBeGreaterThanOrEqual(end.length);
});

// One unit a character: easy to reason about widths.
const unit = (text: string) => text.length;

test("a header name that fits is shown whole", () => {
  expect(fitTitle("refund.png", 40, unit)).toEqual({
    text: "refund.png",
    cut: false,
  });
});

test("a longer name gives way in the middle and keeps its end and extension", () => {
  const name = "refund-flow-recording-before-the-fix-and-after-the-fix.mov";
  const fitted = fitTitle(name, 30, unit);
  expect(fitted.cut).toBe(true);
  expect(fitted.text.length).toBeLessThanOrEqual(30);
  expect(fitted.text.startsWith("refund-flow")).toBe(true);
  expect(fitted.text.endsWith(name.slice(-14))).toBe(true);
  expect(fitted.text).toContain("…");
});

test("a header narrower than its kept end shortens that end too", () => {
  const name = "refund-flow-recording-before-the-fix-and-after-the-fix.mov";
  const fitted = fitTitle(name, 10, unit);
  expect(fitted.text.length).toBeLessThanOrEqual(10);
  expect(fitted.text.endsWith(".mov")).toBe(true);
});

test("an unmeasured header (no width yet) is left alone", () => {
  expect(fitTitle("a-very-long-name.log", 0, unit).cut).toBe(false);
});

test("a cut never splits an emoji or a letter from its accent", () => {
  const broken =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|…́/;
  const names = [
    `${"🎉".repeat(30)}-${"🎉".repeat(9)}b`,
    `${"🎉".repeat(30)}b.png`,
    `${"é".repeat(40)}.log`,
  ];
  for (const name of names) {
    expect(fitName(name, measure).text).not.toMatch(broken);
    expect(fitTitle(name, 100, measure).text).not.toMatch(broken);
  }
});

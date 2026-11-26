import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { breakable, fitName } from "./file-name";

// Seven pixels a letter: 21 letters fit a line of the card.
const measure = (text: string) => text.length * 7;

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

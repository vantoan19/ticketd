import { expect, test } from "vitest";
import { hasVisibleText } from "./brief-text";

test("whitespace entities and zero-width characters are not text", () => {
  expect(hasVisibleText("&#x20;\n&#x20;")).toBe(false);
  expect(hasVisibleText("&nbsp; ​")).toBe(false);
  expect(hasVisibleText("  \n")).toBe(false);
  expect(hasVisibleText("&#x20;done")).toBe(true);
  expect(hasVisibleText("&#x41;")).toBe(true);
  expect(hasVisibleText("&amp;")).toBe(true);
});

test("out-of-range numeric entities remain visible as literal text", () => {
  expect(hasVisibleText("&#x110000;")).toBe(true);
  expect(hasVisibleText("&#1114112;")).toBe(true);
});

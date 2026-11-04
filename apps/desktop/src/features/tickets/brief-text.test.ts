import { expect, test } from "vitest";
import { hasVisibleText } from "./brief-text";

test("whitespace entities and zero-width characters are not text", () => {
  expect(hasVisibleText("&#x20;\n&#x20;")).toBe(false);
  expect(hasVisibleText("&nbsp; ​")).toBe(false);
  expect(hasVisibleText("  \n")).toBe(false);
  expect(hasVisibleText("&#x20;done")).toBe(true);
  expect(hasVisibleText("&amp;")).toBe(true);
});

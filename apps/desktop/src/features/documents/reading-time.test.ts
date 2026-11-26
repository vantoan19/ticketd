import { expect, it } from "vitest";
import { readingMinutes } from "./reading-time";

const words = (count: number) =>
  Array.from({ length: count }, () => "w").join(" ");

it("reads 230 words a minute, and never less than one minute", () => {
  expect(readingMinutes("")).toBe(1);
  expect(readingMinutes(words(100))).toBe(1);
  expect(readingMinutes(words(460))).toBe(2);
  expect(readingMinutes(words(3477))).toBe(15);
});

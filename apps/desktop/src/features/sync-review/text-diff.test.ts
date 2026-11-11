import { expect, test } from "vitest";
import { diffWords } from "./text-diff";

const changed = (parts: { text: string; changed: boolean }[]) =>
  parts.filter((part) => part.changed).map((part) => part.text);

test("marks the words each side has that the other lacks", () => {
  const { before, after } = diffWords(
    "Limit logins per account only.",
    "Limit logins per account and IP address.",
  );
  expect(changed(before)).toEqual(["only."]);
  expect(changed(after)).toEqual(["and IP address."]);
  expect(before.map((part) => part.text).join("")).toBe(
    "Limit logins per account only.",
  );
});

test("identical text has nothing marked", () => {
  const { before, after } = diffWords("Same text", "Same text");
  expect(changed(before)).toEqual([]);
  expect(changed(after)).toEqual([]);
});

test("an added line in the middle is the only change", () => {
  const { before, after } = diffWords("a\nc", "a\nb\nc");
  expect(changed(before)).toEqual([]);
  expect(changed(after).join("").trim()).toBe("b");
});

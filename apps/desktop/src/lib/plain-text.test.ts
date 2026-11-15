import { expect, test } from "vitest";
import { plainLabel, plainSnippet, plainText } from "./plain-text";

test("graph passages and derived names show text, not Markdown or entities", () => {
  expect(
    plainText(
      "Probe link: [Example site]\\(https\\://example.com) and ticket T-FV1.&#xA;&#xA;const shift",
    ),
  ).toBe("Probe link: Example site and ticket T-FV1. const shift");
  expect(
    plainLabel(
      " ## Probe link: [Example site](https://example.com) &amp; more",
    ),
  ).toBe("Probe link: Example site & more");
  // A name with nothing left is still a name.
  expect(plainLabel("  &#xA; ")).toBe("Untitled");
  // Ordinary punctuation in a title survives.
  expect(plainLabel("T-KQ1 · C# notes [draft]")).toBe(
    "T-KQ1 · C# notes [draft]",
  );
});

test("a list excerpt reads table cells as a list, not pipes", () => {
  expect(
    plainSnippet("…T-FV1. | Column | Cards | Shift |const shift = x…"),
  ).toBe("…T-FV1. · Column · Cards · Shift · const shift = x…");
  expect(plainSnippet("| Column | Cards |")).toBe("Column · Cards");
});

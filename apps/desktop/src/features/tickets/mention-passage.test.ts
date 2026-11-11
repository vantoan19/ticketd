import { expect, test } from "vitest";
import {
  charSpanToUtf16,
  isMentionBlock,
  mentionStillAt,
  withoutBom,
  type PositionedNode,
} from "./mention-passage";

const at = (start: number, end: number) => ({
  start: { offset: start },
  end: { offset: end },
});
const element = (
  tagName: string,
  start: number,
  end: number,
  children: PositionedNode[] = [],
): PositionedNode => ({
  type: "element",
  tagName,
  position: at(start, end),
  children,
});

test("only the innermost block containing the span is the mention block", () => {
  const paragraph = element("p", 4, 20);
  const item = element("li", 2, 20, [paragraph]);
  const span = { start: 10, end: 13 };
  expect(isMentionBlock(item, span)).toBe(false);
  expect(isMentionBlock(paragraph, span)).toBe(true);
  expect(isMentionBlock(element("p", 30, 40), span)).toBe(false);
});

test("a span that straddles blocks, or code, never matches", () => {
  expect(isMentionBlock(element("p", 0, 10), { start: 8, end: 13 })).toBe(
    false,
  );
  expect(isMentionBlock(element("pre", 0, 40), { start: 8, end: 11 })).toBe(
    false,
  );
  expect(isMentionBlock(element("p", 0, 40), { start: 8, end: 11 })).toBe(true);
  // Positions are optional in hast; without them nothing matches.
  expect(
    isMentionBlock({ type: "element", tagName: "p" }, { start: 0, end: 1 }),
  ).toBe(false);
});

test("the passage must still sit around the span in the current source", () => {
  const source = "Intro.\n\nBlocked on T-KQ1 today.";
  const passage = "Blocked on T-KQ1 today.";
  expect(mentionStillAt(source, passage, { start: 19, end: 22 })).toBe(true);
  expect(
    mentionStillAt("Added.\n\n" + source, passage, { start: 19, end: 22 }),
  ).toBe(true);
  expect(
    mentionStillAt("Intro: T-KQ1 is the parent.", passage, {
      start: 19,
      end: 22,
    }),
  ).toBe(false);
  expect(mentionStillAt("short", passage, { start: 19, end: 22 })).toBe(false);
});

test("the core's char span becomes UTF-16 offsets, astral characters counting twice", () => {
  const text = "😀 é 𝒳 T-KQ1 ok";
  const start = [...text].indexOf("T");
  const span = charSpanToUtf16(text, { start, end: start + 5 });
  expect(span).not.toBeNull();
  expect(text.slice(span?.start, span?.end)).toBe("T-KQ1");
  // A span that ends the text, and one past it.
  expect(charSpanToUtf16("a😀", { start: 1, end: 2 })).toEqual({
    start: 1,
    end: 3,
  });
  expect(charSpanToUtf16("ab", { start: 1, end: 5 })).toBeNull();
});

test("a leading byte order mark is dropped before offsets apply", () => {
  expect(withoutBom("\uFEFFSee T-KQ1")).toBe("See T-KQ1");
  expect(withoutBom("See \uFEFFT-1")).toBe("See \uFEFFT-1");
});

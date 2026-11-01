import { expect, test } from "vitest";
import {
  isMentionBlock,
  mentionStillAt,
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
  const source = "Intro.\n\nBlocked on T-1 today.";
  const passage = "Blocked on T-1 today.";
  expect(mentionStillAt(source, passage, { start: 19, end: 22 })).toBe(true);
  expect(
    mentionStillAt("Added.\n\n" + source, passage, { start: 19, end: 22 }),
  ).toBe(true);
  expect(
    mentionStillAt("Intro: T-1 is the parent.", passage, {
      start: 19,
      end: 22,
    }),
  ).toBe(false);
  expect(mentionStillAt("short", passage, { start: 19, end: 22 })).toBe(false);
});

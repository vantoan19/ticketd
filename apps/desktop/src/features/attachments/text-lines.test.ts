import { expect, test } from "vitest";
import {
  BLOCK_LINES,
  blockAt,
  blockTops,
  estimateBlocks,
  findMatches,
  firstMatchFrom,
  lastLines,
  parseLines,
  rowsOf,
  searchIndex,
  selectionText,
} from "./text-lines";

// Long lines and repeated text, the shape of a test-runner log.
const LONG = "GET /api/tickets?filter=" + "status%3Dopen%26".repeat(40);
const log = [
  "2026-11-26 12:00:01 INFO start",
  `2026-11-26 12:00:02 WARN ${LONG}`,
  "2026-11-26 12:00:03 ERROR timeout after 30s",
  "ERROR timeout after 30s, error again",
  "",
  "done",
].join("\r\n");

test("lines split on every kind of break and a last break adds no empty line", () => {
  expect(parseLines("a\nb\r\nc\rd\n").lines).toEqual(["a", "b", "c", "d"]);
  expect(parseLines("").lines).toEqual([]);
  expect(parseLines("one").lines).toEqual(["one"]);
  expect(parseLines("a\n\nb").lines).toEqual(["a", "", "b"]);
});

test("find lists every match in reading order, ignoring case, one line at a time", () => {
  const parsed = parseLines(log);
  const { matches, capped } = findMatches(searchIndex(log, parsed), "error");
  expect(capped).toBe(false);
  expect(matches).toEqual([
    { line: 2, start: 20, end: 25 },
    { line: 3, start: 0, end: 5 },
    { line: 3, start: 25, end: 30 },
  ]);
  // The repeated fragment on the long line matches each time it appears.
  const index = searchIndex(log, parsed);
  expect(findMatches(index, "status%3Dopen").matches).toHaveLength(40);
  // A phrase never spans a line break, and an empty one finds nothing.
  expect(findMatches(index, "30s\n").matches).toEqual([]);
  expect(findMatches(index, "").matches).toEqual([]);
  // The first match on or after a line.
  const all = findMatches(index, "error").matches;
  expect(firstMatchFrom(all, 3)).toBe(1);
  expect(firstMatchFrom(all, 4)).toBe(3);
});

test("find stops at the cap and says so", () => {
  const text = "x\n".repeat(30_000);
  const result = findMatches(searchIndex(text, parseLines(text)), "x");
  expect(result.capped).toBe(true);
  expect(result.matches).toHaveLength(20_000);
});

test("wrapped lines take rows like a terminal with a 4-character hang", () => {
  expect(rowsOf(80, 80, true)).toBe(1);
  expect(rowsOf(81, 80, true)).toBe(2);
  expect(rowsOf(80 + 76, 80, true)).toBe(2);
  expect(rowsOf(80 + 77, 80, true)).toBe(3);
  expect(rowsOf(5000, 80, false)).toBe(1);
});

test("block heights add up and a pixel finds its block", () => {
  const lines = Array.from({ length: BLOCK_LINES * 2 + 1 }, () => "a");
  const heights = estimateBlocks(lines, 80, true);
  expect([...heights]).toEqual([BLOCK_LINES * 20, BLOCK_LINES * 20, 20]);
  const tops = blockTops(heights);
  expect(tops[3]).toBe((BLOCK_LINES * 2 + 1) * 20);
  expect(blockAt(tops, 0)).toBe(0);
  expect(blockAt(tops, BLOCK_LINES * 20)).toBe(1);
  expect(blockAt(tops, 1e9)).toBe(2);
});

test("a selection across lines copies their text without anything around it", () => {
  const { lines } = parseLines(log);
  expect(
    selectionText(lines, { line: 0, column: 20 }, { line: 0, column: 24 }),
  ).toBe("INFO");
  expect(
    selectionText(lines, { line: 2, column: 20 }, { line: 4, column: 0 }),
  ).toBe("ERROR timeout after 30s\nERROR timeout after 30s, error again\n");
  // Either end first.
  expect(
    selectionText(lines, { line: 3, column: 5 }, { line: 3, column: 0 }),
  ).toBe("ERROR");
});

test("a file of too many lines keeps its last lines and counts the ones before", () => {
  expect(lastLines("a\nb\nc\n", 3)).toEqual({ text: "a\nb\nc\n", dropped: 0 });
  expect(lastLines("a\nb\nc\n", 2)).toEqual({ text: "b\nc\n", dropped: 1 });
  // A last line with no break counts, and \r\n is one break.
  expect(lastLines("a\r\nb\r\nc", 2)).toEqual({ text: "b\r\nc", dropped: 1 });
  expect(lastLines("a\nb\nc\nd", 1)).toEqual({ text: "d", dropped: 3 });
  expect(lastLines("", 5)).toEqual({ text: "", dropped: 0 });
});

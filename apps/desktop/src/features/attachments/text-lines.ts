/*
 * The pure parts of the log stage: splitting text into lines, finding a phrase,
 * estimating how tall each group of lines is so only the visible ones are drawn,
 * and rebuilding the text of a selection that spans lines that are not drawn.
 */

/** One text row, in pixels (Geist Mono 13/20). */
export const LINE_HEIGHT = 20;
/** Lines are drawn and measured in groups, so a million lines are 16 thousand blocks. */
export const BLOCK_LINES = 64;
/** Wrapped lines hang this many characters in from where their line starts. */
export const HANG = 4;
/** The most matches Find lists; more are counted as "N+". */
export const MATCH_CAP = 20_000;

/**
 * The most lines the stage draws. A scrolling element tops out near 33 million
 * pixels, so a file of millions of short lines shows its last million (20
 * million pixels) and says so.
 */
export const MAX_LINES = 1_000_000;

export type Lines = {
  lines: string[];
  /** Where each line starts in the original text. */
  starts: Uint32Array;
};

/**
 * Splits on \n, \r\n and a lone \r (a progress bar redraws with it). A final line
 * break does not add an empty last line.
 */
export function parseLines(text: string): Lines {
  const lines: string[] = [];
  const starts: number[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    lines.push(text.slice(start, index));
    starts.push(start);
    if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
    start = index + 1;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
    starts.push(start);
  }
  return { lines, starts: Uint32Array.from(starts) };
}

/**
 * The last `max` lines of `text`, and how many lines came before them. It counts
 * line breaks the way `parseLines` splits them, without building the lines.
 */
export function lastLines(text: string, max: number) {
  const walk = (stopAfter: number) => {
    let breaks = 0;
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code !== 10 && code !== 13) continue;
      if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
      breaks++;
      start = index + 1;
      if (breaks === stopAfter) break;
    }
    return { breaks, start };
  };
  const counted = walk(Infinity);
  const total = counted.breaks + (counted.start < text.length ? 1 : 0);
  if (total <= max) return { text, dropped: 0 };
  const dropped = total - max;
  return { text: text.slice(walk(dropped).start), dropped };
}

export type Match = { line: number; start: number; end: number };

/** Find reads the text once; the lower-cased copy is made on first use. */
export type SearchIndex = {
  text: string;
  parsed: Lines;
  lowered: string | null;
};
export function searchIndex(text: string, parsed: Lines): SearchIndex {
  return { text, parsed, lowered: null };
}

/** The line a text offset falls in (the last line that starts at or before it). */
function lineAt(starts: Uint32Array, offset: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Every place `query` occurs, ignoring case, in reading order; at most
 * `MATCH_CAP`. A match never spans a line break. Where lower-casing changes the
 * text's length (a few scripts), it matches case-sensitively instead of
 * pointing at the wrong characters.
 */
export function findMatches(
  index: SearchIndex,
  query: string,
): { matches: Match[]; capped: boolean } {
  const matches: Match[] = [];
  if (!query) return { matches, capped: false };
  const { text, parsed } = index;
  index.lowered ??= text.toLowerCase();
  const insensitive = index.lowered.length === text.length;
  const haystack = insensitive ? index.lowered : text;
  const needle = insensitive ? query.toLowerCase() : query;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return { matches, capped: false };
    from = at + Math.max(needle.length, 1);
    const line = lineAt(parsed.starts, at);
    const start = at - parsed.starts[line]!;
    const end = start + needle.length;
    if (end > parsed.lines[line]!.length) continue;
    if (matches.length >= MATCH_CAP) return { matches, capped: true };
    matches.push({ line, start, end });
  }
}

/** The index of the first match on `line` or after it (matches.length when none). */
export function firstMatchFrom(matches: readonly Match[], line: number) {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (matches[middle]!.line < line) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Rows one line takes: all characters wrap exactly like a terminal, then hang by `HANG`. */
export function rowsOf(length: number, columns: number, wrap: boolean) {
  if (!wrap || length <= columns) return 1;
  return 1 + Math.ceil((length - columns) / Math.max(columns - HANG, 1));
}

/** Estimated pixel height of each block of lines. */
export function estimateBlocks(
  lines: readonly string[],
  columns: number,
  wrap: boolean,
): Float64Array {
  const blocks = Math.ceil(lines.length / BLOCK_LINES);
  const heights = new Float64Array(blocks);
  for (let block = 0; block < blocks; block++) {
    const end = Math.min((block + 1) * BLOCK_LINES, lines.length);
    let rows = 0;
    for (let line = block * BLOCK_LINES; line < end; line++)
      rows += rowsOf(lines[line]!.length, columns, wrap);
    heights[block] = rows * LINE_HEIGHT;
  }
  return heights;
}

/** Where each block starts, with the total at the end. */
export function blockTops(heights: ArrayLike<number>): Float64Array {
  const tops = new Float64Array(heights.length + 1);
  for (let block = 0; block < heights.length; block++)
    tops[block + 1] = tops[block]! + heights[block]!;
  return tops;
}

/** The block that holds pixel `offset` (clamped to the first and last). */
export function blockAt(tops: Float64Array, offset: number) {
  const last = tops.length - 2;
  if (last < 0) return 0;
  let low = 0;
  let high = last;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (tops[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** A place in the text: a line and a character in it. */
export type Position = { line: number; column: number };

/**
 * The text between two positions, joined with \n. A selection that crosses
 * lines that are not drawn still copies in full, and without the line numbers.
 */
export function selectionText(
  lines: readonly string[],
  from: Position,
  to: Position,
) {
  const [start, end] =
    from.line < to.line || (from.line === to.line && from.column <= to.column)
      ? [from, to]
      : [to, from];
  if (start.line === end.line)
    return (lines[start.line] ?? "").slice(start.column, end.column);
  const parts = [(lines[start.line] ?? "").slice(start.column)];
  for (let line = start.line + 1; line < end.line; line++)
    parts.push(lines[line] ?? "");
  parts.push((lines[end.line] ?? "").slice(0, end.column));
  return parts.join("\n");
}

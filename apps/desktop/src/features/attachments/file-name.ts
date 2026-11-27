import { createElement, Fragment, type ReactNode } from "react";

/**
 * The room for a name inside a 176px card: its width less 10px of padding a
 * side is 156px; 2px of that is slack, so a name the canvas measures as fitting
 * still fits the box after the browser's own rounding (WebKit sets the 154px
 * "e2e-run-2026-11-25.log" a pixel or two wider than a canvas does).
 */
const WIDTH = 154;
/** The end that always stays visible: a date, a run number, the extension. */
const KEEP = 14;
/** A kept end shorter than this is no use as a landmark: fall back to KEEP characters. */
const MIN_END = 6;
/** Without a way to measure text, about two lines of a card's name. */
const LIMIT = 36;

type Measure = (text: string) => number;

// A name is cut between letters as a reader sees them, never inside an emoji
// (two UTF-16 units) or between a letter and its accent.
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter()
    : null;
function pieces(text: string): string[] {
  return segmenter
    ? Array.from(segmenter.segment(text), (part) => part.segment)
    : Array.from(text);
}
const dropFirst = (text: string) => pieces(text).slice(1).join("");
const dropLast = (text: string) => pieces(text).slice(0, -1).join("");
/** The last whole letters of `text` that fit in `units` UTF-16 units (at least one). */
function lastUnits(text: string, units: number): string {
  let out = "";
  for (const piece of pieces(text).reverse()) {
    if (out && out.length + piece.length > units) break;
    out = piece + out;
  }
  return out;
}
/** The first whole letters of `text` that fit in `units` UTF-16 units. */
function firstUnits(text: string, units: number): string {
  let out = "";
  for (const piece of pieces(text)) {
    if (out.length + piece.length > units) break;
    out += piece;
  }
  return out;
}
export type FittedName = {
  /** The name to show, cut in the middle when it is too long. */
  text: string;
  cut: boolean;
  /** When cut and measured: the two lines to show as they are. */
  lines?: [string, string];
};

// Text is measured on an OffscreenCanvas in the name's own font; where there is
// none (a test), names are cut by length instead.
let measureText: Measure | null | undefined;
function measurer(): Measure | null {
  if (measureText !== undefined) return measureText;
  measureText = null;
  if (typeof OffscreenCanvas !== "undefined") {
    const context = new OffscreenCanvas(1, 1).getContext("2d");
    if (context) {
      context.font = "14px Geist, sans-serif";
      measureText = (text) => context.measureText(text).width;
    }
  }
  return measureText;
}

/**
 * The pieces a name can break between: after `-`, `_`, `.` and spaces, except
 * that the extension stays attached to what precedes it, so a line never ends
 * with "report." and leaves "log" alone on the next.
 */
function tokens(name: string, separators = /(?<=[-_. ])/): string[] {
  const parts = name.split(separators);
  const last = parts.at(-1);
  const before = parts.at(-2);
  if (
    last &&
    !/[-_. ]$/.test(last) &&
    before?.endsWith(".") &&
    before.length > 1
  )
    parts.splice(-2, 2, before + last);
  return parts;
}

/**
 * The end a cut name always shows: the longest run of whole words (from a
 * separator on) of at most KEEP characters, so the cut falls between words.
 * A name whose last word is longer than that keeps its last KEEP characters.
 */
function keptEnd(name: string): string {
  const parts = tokens(name);
  let end = "";
  for (let index = parts.length - 1; index > 0; index--) {
    const next = parts[index]! + end;
    if (next.length > KEEP) break;
    end = next;
  }
  return end.length >= MIN_END ? end : lastUnits(name, KEEP);
}

/** Greedy wrap at `-`, `_`, `.` and spaces, as the card's two lines do. */
function firstLine(name: string, measure: Measure): string {
  let line = "";
  for (const token of tokens(name)) {
    if (measure(line + token) <= WIDTH) {
      line += token;
      continue;
    }
    if (line) return line;
    // One word wider than the card breaks wherever it must.
    for (const character of token) {
      if (measure(line + character) > WIDTH) return line || character;
      line += character;
    }
  }
  return line;
}

/**
 * A card's name for up to two lines. A longer name gives way in the middle of its
 * second line, so its end stays visible; the cut falls between words and the
 * ellipsis sits right against the end that is kept.
 */
export function fitName(name: string, measure = measurer()): FittedName {
  const tail = keptEnd(name);
  if (!measure) {
    return name.length <= LIMIT
      ? { text: name, cut: false }
      : {
          text: `${firstUnits(name, LIMIT - tail.length - 1).trimEnd()}…${tail}`,
          cut: true,
        };
  }
  if (measure(name) <= WIDTH) return { text: name, cut: false };
  const first = firstLine(name, measure);
  const rest = name.slice(first.length);
  if (measure(rest) <= WIDTH) return { text: name, cut: false };
  // The end comes from the second line, never from the first, and gives up
  // letters until it fits: a wide script can make 14 of them wider than a line.
  let end = keptEnd(rest);
  while (end.length > 1 && measure(`…${end}`) > WIDTH) end = dropFirst(end);
  let head = rest.slice(0, Math.max(0, rest.length - end.length));
  while (head && measure(`${head}…${end}`) > WIDTH) head = dropLast(head);
  // The cut falls between words when there is a word to fall between, and the
  // ellipsis sits against the words it joins, not against a separator.
  const wholeWords = head.match(/^(.*[-_. ])[^-_. ]*$/)?.[1];
  const trimmed = (wholeWords ?? head).replace(/[-_. ]+$/, "");
  if (trimmed) head = trimmed;
  const second = `${head}…${end}`;
  return { text: first + second, cut: true, lines: [first, second] };
}

/** Lets a line break after `-`, `_` and `.` as well as at spaces. */
export function breakable(text: string): ReactNode {
  const parts = tokens(text, /(?<=[-_.])/);
  return parts.map((part, index) =>
    createElement(
      Fragment,
      { key: index },
      index > 0 && createElement("wbr"),
      part,
    ),
  );
}

/**
 * A viewer header's name on one line of `width` px: the same rule as a card's,
 * so a longer name gives way in the middle and keeps its end and extension.
 */
export function fitTitle(
  name: string,
  width: number,
  measure: Measure,
): FittedName {
  if (width <= 0 || measure(name) <= width) return { text: name, cut: false };
  let tail = lastUnits(name, KEEP);
  // A title narrower than its kept end gives up letters from that end too.
  while (tail.length > 1 && measure(`…${tail}`) > width) tail = dropFirst(tail);
  let head = name.slice(0, Math.max(0, name.length - tail.length));
  while (head && measure(`${head}…${tail}`) > width) head = dropLast(head);
  return { text: `${head}…${tail}`, cut: true };
}

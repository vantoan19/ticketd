import { createElement, Fragment, type ReactNode } from "react";

/** The room for a name inside a 176px card: its width less 12px of padding a side. */
const WIDTH = 152;
/** The end that always stays visible: a date, a run number, the extension. */
const KEEP = 14;
/** A kept end shorter than this is no use as a landmark: fall back to KEEP characters. */
const MIN_END = 6;
/** Without a way to measure text, about two lines of a card's name. */
const LIMIT = 36;

type Measure = (text: string) => number;
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
  return end.length >= MIN_END ? end : name.slice(-KEEP);
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
          text: `${name.slice(0, LIMIT - tail.length - 1).trimEnd()}…${tail}`,
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
  while (end.length > 1 && measure(`…${end}`) > WIDTH) end = end.slice(1);
  let head = rest.slice(0, Math.max(0, rest.length - end.length));
  while (head && measure(`${head}…${end}`) > WIDTH) head = head.slice(0, -1);
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
  const tail = name.slice(-KEEP);
  let head = name.slice(0, Math.max(0, name.length - KEEP));
  while (head && measure(`${head}…${tail}`) > width) head = head.slice(0, -1);
  return { text: `${head}…${tail}`, cut: true };
}

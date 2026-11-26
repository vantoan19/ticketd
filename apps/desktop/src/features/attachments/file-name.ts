import { createElement, Fragment, type ReactNode } from "react";

/** The room for a name inside a 176px card: its width less 12px of padding a side. */
const WIDTH = 152;
/** The end that always stays visible: a date, a run number, the extension. */
const KEEP = 14;
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

/** Greedy wrap at `-`, `_`, `.` and spaces, as the card's two lines do. */
function firstLine(name: string, measure: Measure): string {
  let line = "";
  for (const token of name.split(/(?<=[-_. ])/)) {
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
 * second line, so its end stays visible; the ellipsis sits right against that end
 * and any spaces at the cut are kept.
 */
export function fitName(name: string, measure = measurer()): FittedName {
  const tail = name.slice(-KEEP);
  if (!measure) {
    return name.length <= LIMIT
      ? { text: name, cut: false }
      : {
          text: `${name.slice(0, LIMIT - KEEP - 1)}…${tail}`,
          cut: true,
        };
  }
  if (measure(name) <= WIDTH) return { text: name, cut: false };
  const first = firstLine(name, measure);
  const rest = name.slice(first.length);
  if (measure(rest) <= WIDTH) return { text: name, cut: false };
  // The end comes from the second line, never from the first, and gives up
  // letters until it fits: a wide script can make 14 of them wider than a line.
  let end = rest.slice(-KEEP);
  while (end.length > 1 && measure(`…${end}`) > WIDTH) end = end.slice(1);
  let head = rest.slice(0, rest.length - end.length);
  while (head && measure(`${head}…${end}`) > WIDTH) head = head.slice(0, -1);
  const second = `${head}…${end}`;
  return { text: first + second, cut: true, lines: [first, second] };
}

/** Lets a line break after `-`, `_` and `.` as well as at spaces. */
export function breakable(text: string): ReactNode {
  const parts = text.split(/(?<=[-_.])/);
  return parts.map((part, index) =>
    createElement(
      Fragment,
      { key: index },
      index > 0 && createElement("wbr"),
      part,
    ),
  );
}

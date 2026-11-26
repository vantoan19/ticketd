import { createElement, Fragment, type ReactNode } from "react";

/** About two lines of a 176px card's name: beyond this the middle gives way. */
const LIMIT = 40;
/** The end that always stays visible: a date, a run number, the extension. */
const KEEP = 14;

/**
 * A card's name for up to two lines. A longer name gives way in the middle, so
 * its end stays visible; the ellipsis sits right against that end and any
 * spaces at the cut are kept.
 */
export function fitName(name: string): { text: string; cut: boolean } {
  if (name.length <= LIMIT) return { text: name, cut: false };
  return {
    text: `${name.slice(0, LIMIT - KEEP - 1)}…${name.slice(-KEEP)}`,
    cut: true,
  };
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

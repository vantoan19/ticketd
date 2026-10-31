import type { ReactNode } from "react";

/** Render a passage with every occurrence of `reference` emphasized. */
export function EmphasizedPassage({
  text,
  reference,
}: {
  text: string;
  reference: string;
}): ReactNode {
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = text.indexOf(reference); at !== -1;) {
    const end = at + reference.length;
    // Only whole references count, so T-1 does not highlight inside T-12.
    const word = /[\p{L}\p{N}_-]/u;
    if (!word.test(text[at - 1] ?? "") && !word.test(text[end] ?? "")) {
      parts.push(text.slice(from, at), <mark key={at}>{reference}</mark>);
      from = end;
    }
    at = text.indexOf(reference, end);
  }
  parts.push(text.slice(from));
  return parts;
}

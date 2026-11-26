import type { ReactNode } from "react";

/** The words of a search query, as the core reads them: split on whitespace. */
export function queryWords(query: string) {
  return [...new Set(query.trim().split(/\s+/).filter(Boolean))];
}

/** Whether every word of the query is in the text, ignoring case: a "title match". */
export function matchesTitle(heading: string, query: string) {
  const words = queryWords(query);
  const lower = heading.toLowerCase();
  return (
    words.length > 0 &&
    words.every((word) => lower.includes(word.toLowerCase()))
  );
}

/**
 * The text with each occurrence of a query word in a <mark>. The mark's fill and underline
 * come from `.document-list mark`, so a match never relies on colour alone.
 */
export function highlight(text: string, query: string): ReactNode[] | string {
  const words = queryWords(query).sort((a, b) => b.length - a.length);
  if (words.length === 0) return text;
  const pattern = new RegExp(
    words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "giu",
  );
  const parts: ReactNode[] = [];
  let from = 0;
  for (const found of text.matchAll(pattern)) {
    if (found[0] === "") continue;
    if (found.index > from) parts.push(text.slice(from, found.index));
    parts.push(<mark key={found.index}>{found[0]}</mark>);
    from = found.index + found[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}

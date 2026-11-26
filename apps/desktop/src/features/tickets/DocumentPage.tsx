import { useEffect, useState } from "react";
import { documents } from "@/features/documents/api";
import { plainText } from "@/lib/plain-text";

/** Lines of the first page a card's paper shows; the rest is cropped by the frame anyway. */
const LINES = 9;

/** The first lines of a Document's body as plain text: no title, rules, fences or table dividers. */
function firstLines(body: string, title: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  let skippedTitle = false;
  for (const raw of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    const text = plainText(fenced ? raw : raw.replace(/^\s*[-*+]\s+/, ""));
    if (!text || /^[-=_:| ]+$/.test(text)) continue;
    // The title is the body's first line when the Document has no title of its own.
    if (!skippedTitle) {
      skippedTitle = true;
      if (text === title) continue;
    }
    lines.push(text);
    if (lines.length === LINES) break;
  }
  return lines;
}

/**
 * A Document's first page for a card's frame: its title and first lines as
 * text on white paper (the same paper as a PDF's first page). Read once the
 * card is near the viewport; a Document that cannot be read keeps the tile.
 */
export function DocumentPage({
  id,
  title,
  wanted,
}: {
  id: string;
  title: string;
  wanted: boolean;
}) {
  const [page, setPage] = useState<{ id: string; lines: string[] } | null>(
    null,
  );
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    documents
      .show(id)
      .then((document) => {
        const lines = firstLines(document.body, title);
        if (current) setPage({ id, lines });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [wanted, id, title]);
  if (page?.id !== id) return null;
  return (
    <span className="file-card-page" data-paper="" aria-hidden="true">
      <strong>{title}</strong>
      {page.lines.map((line, index) => (
        <span key={index}>{line}</span>
      ))}
    </span>
  );
}

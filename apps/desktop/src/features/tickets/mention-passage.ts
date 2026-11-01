const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre";

/** Compare text by its letters and digits only: Markdown syntax drops out of the passage. */
function key(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function mentions(text: string, reference: string): boolean {
  const word = /[\p{L}\p{N}_-]/u;
  for (let at = text.indexOf(reference); at !== -1;) {
    const end = at + reference.length;
    if (!word.test(text[at - 1] ?? "") && !word.test(text[end] ?? ""))
      return true;
    at = text.indexOf(reference, end);
  }
  return false;
}

/** The innermost block, so a list item wins over its list and a paragraph over its quote. */
function innermost(blocks: Element[]): Element | null {
  return (
    blocks.find(
      (block) =>
        !blocks.some((other) => other !== block && block.contains(other)),
    ) ?? null
  );
}

/**
 * Find the rendered block that holds a backlink passage. The passage is a source line
 * of the Markdown, so it is matched by its words first; when the description has
 * changed or the line carries link syntax, the first block mentioning the reference
 * stands in. Null means the description no longer mentions it.
 */
export function findMentionBlock(
  root: Element,
  passage: string,
  reference: string,
): Element | null {
  const blocks = [...root.querySelectorAll(BLOCKS)];
  const wanted = key(passage);
  const exact = wanted
    ? blocks.filter((block) => key(block.textContent ?? "").includes(wanted))
    : [];
  const byPassage = innermost(exact);
  if (byPassage) return byPassage;
  return innermost(
    blocks.filter((block) => mentions(block.textContent ?? "", reference)),
  );
}

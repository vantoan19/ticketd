/**
 * One-line plain text from stored Markdown, for names, passages and snippets
 * that are shown outside a Markdown renderer.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes character references such as `&#xA;` and `&amp;`; unknown ones stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    (match, ref: string) => {
      if (!ref.startsWith("#")) return NAMED[ref.toLowerCase()] ?? match;
      const hex = ref[1] === "x" || ref[1] === "X";
      const code = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    },
  );
}

/** `\(` → `(`: Markdown's backslash escapes before ASCII punctuation. */
const withoutEscapes = (text: string) =>
  text.replace(/\\([!-/:-@[-`{-~])/g, "$1");

/** `[text](url)` and `![alt](url)` → their text. */
const linkText = (text: string) =>
  text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * A name derived from Markdown (a Document's first line, a graph label): link
 * text without the link, no escapes or entities, no heading marks, and
 * "Untitled" when nothing is left.
 */
export function plainLabel(text: string): string {
  return (
    oneLine(
      linkText(withoutEscapes(decodeEntities(text))).replace(
        /^\s*#{1,6}\s+/,
        "",
      ),
    ) || "Untitled"
  );
}

/** A quoted passage: link text, and none of the Markdown marks around it. */
export function plainText(markdown: string): string {
  return oneLine(
    linkText(withoutEscapes(decodeEntities(markdown)))
      .replace(/ticketd:\/\/\S+/g, "")
      .replace(/[`*_>#]/g, ""),
  );
}

/**
 * A list excerpt: table cells and blocks the excerpt ran together read as
 * "a · b" instead of "| a | b |".
 */
export function plainSnippet(text: string): string {
  return oneLine(decodeEntities(text))
    .replace(/\s*\|[\s|]*/g, " · ")
    .replace(/^(…?)\s*·\s*/, "$1")
    .replace(/\s*·\s*(…?)$/, "$1")
    .trim();
}

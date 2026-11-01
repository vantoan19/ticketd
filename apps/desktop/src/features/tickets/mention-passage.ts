/** A mention's place in the Markdown source, in UTF-16 code units (JavaScript string offsets). */
export type MentionSpan = { start: number; end: number };

/** The text a Markdown renderer sees: the parser drops a leading byte order mark. */
export function withoutBom(source: string): string {
  return source.startsWith("\uFEFF") ? source.slice(1) : source;
}

/**
 * Convert the core's span, counted in Unicode scalar values (chars) of the
 * BOM-less body, to UTF-16 offsets into that same text. Null when it lies
 * outside the text.
 */
export function charSpanToUtf16(
  text: string,
  span: MentionSpan,
): MentionSpan | null {
  let units = 0;
  let chars = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const char of text) {
    if (chars === span.start) start = units;
    if (chars === span.end) end = units;
    units += char.length;
    chars++;
  }
  if (chars === span.start) start = units;
  if (chars === span.end) end = units;
  return start === null || end === null || start > end ? null : { start, end };
}

/** The part of a hast node this module reads. */
export type PositionedNode = {
  type: string;
  tagName?: string;
  position?: {
    start: { offset?: number | undefined };
    end: { offset?: number | undefined };
  };
  children?: PositionedNode[];
};

/**
 * Blocks that may carry a mention. Code blocks are left out on purpose: the
 * backend never reports mentions inside code, and their tab stops are not ours.
 */
export const MENTION_BLOCKS: ReadonlySet<string> = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "td",
  "th",
]);

function contains(node: PositionedNode, span: MentionSpan): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return (
    start !== undefined &&
    end !== undefined &&
    start <= span.start &&
    span.end <= end
  );
}

function hasInnerBlock(node: PositionedNode, span: MentionSpan): boolean {
  return (node.children ?? []).some(
    (child) =>
      (child.type === "element" &&
        MENTION_BLOCKS.has(child.tagName ?? "") &&
        contains(child, span)) ||
      hasInnerBlock(child, span),
  );
}

/** Whether this block is the innermost one whose source contains the mention. */
export function isMentionBlock(
  node: PositionedNode | undefined,
  span: MentionSpan,
): boolean {
  return (
    node !== undefined &&
    node.type === "element" &&
    MENTION_BLOCKS.has(node.tagName ?? "") &&
    contains(node, span) &&
    !hasInnerBlock(node, span)
  );
}

/**
 * Whether the source still has the passage where the backlink found it. A
 * description edited since then moves or removes the passage, and its span would
 * point at something else.
 */
export function mentionStillAt(
  source: string,
  passage: string,
  span: MentionSpan,
): boolean {
  if (span.end > source.length || span.start > span.end) return false;
  const from = Math.max(0, span.start - passage.length);
  return source.slice(from, span.end + passage.length).includes(passage);
}

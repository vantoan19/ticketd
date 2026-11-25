import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * One heading of a Document, as the outline lists it. The same list feeds the
 * ticks beside the list, the full-width rail and section folding, so it holds
 * what each needs: the level, the text, a stable anchor and where the heading
 * starts in the Markdown (the rendered heading finds its anchor by that).
 */
export type OutlineHeading = {
  /** Unique within the Document. */
  id: string;
  /** 1 to 4. Deeper headings are not outlined. */
  level: 1 | 2 | 3 | 4;
  text: string;
  /** A section (h1, h2) rather than a subsection under one. */
  section: boolean;
  /** Source offset where the heading starts. */
  offset: number;
  /**
   * Whether the section can be folded: an h2 or h3 that is a block of its own in
   * the Document (not one inside a quote or a list).
   */
  foldable: boolean;
  /** The first sentence under the heading, shown on its line while it is folded. */
  summary: string;
};

/** An outline appears from three headings; a shorter Document is plain. */
export const OUTLINE_MINIMUM = 3;

type Node = {
  type: string;
  depth?: number;
  value?: string;
  alt?: string;
  children?: Node[];
  position?: { start: { offset?: number } };
};

const parser = unified().use(remarkParse).use(remarkGfm);

function plainText(node: Node): string {
  if (node.children) return node.children.map(plainText).join("");
  if (node.type === "image") return node.alt ?? "";
  return node.value ?? "";
}

/** "Plan & spec: v2" becomes "plan-spec-v2"; a heading without letters is "section". */
function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

const SENTENCE = /^.*?[.!?](?=\s|$)/s;
const SUMMARY_LENGTH = 200;

/** The text of a block that reads as a sentence, or "" for code, tables and rules. */
function blockText(node: Node): string {
  if (node.type === "paragraph") return plainText(node);
  if (node.type === "blockquote" || node.type === "list")
    return node.children?.map(blockText).find(Boolean) ?? "";
  if (node.type === "listItem") return plainText(node);
  return "";
}

/**
 * The first sentence of the section that starts at `siblings[index]`: the first
 * paragraph (or quote or list) before the next heading, cut at its first full stop.
 */
function summaryAfter(siblings: readonly Node[], index: number): string {
  for (const node of siblings.slice(index + 1)) {
    if (node.type === "heading") return "";
    const text = blockText(node).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const sentence = SENTENCE.exec(text)?.[0] ?? text;
    return sentence.length > SUMMARY_LENGTH
      ? `${sentence.slice(0, SUMMARY_LENGTH).trimEnd()}…`
      : sentence;
  }
  return "";
}

/**
 * The headings of what Read renders (h1 to h4), in order, each with an anchor.
 * A repeated heading gets "-1", "-2" and so on, so anchors never collide.
 */
export function outlineOf(source: string): OutlineHeading[] {
  const tree = parser.parse(source) as Node;
  const found: Omit<OutlineHeading, "id" | "section">[] = [];
  const walk = (node: Node, siblings: readonly Node[], index: number) => {
    if (
      node.type === "heading" &&
      node.depth !== undefined &&
      node.depth <= 4 &&
      node.position?.start.offset !== undefined
    ) {
      const top = siblings === tree.children;
      const foldable = top && (node.depth === 2 || node.depth === 3);
      found.push({
        level: node.depth as 1 | 2 | 3 | 4,
        text: plainText(node).trim(),
        offset: node.position.start.offset,
        foldable,
        summary: foldable ? summaryAfter(siblings, index) : "",
      });
      return;
    }
    node.children?.forEach((child, at, all) => walk(child, all, at));
  };
  tree.children?.forEach((child, at, all) => walk(child, all, at));
  // A Document that only has h3s and h4s still has sections: its shallowest level.
  const shallowest = Math.max(2, Math.min(4, ...found.map((h) => h.level)));
  const used = new Map<string, number>();
  return found.map((heading) => {
    const base = slug(heading.text);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return {
      ...heading,
      id: seen === 0 ? base : `${base}-${seen}`,
      section: heading.level <= shallowest,
    };
  });
}

export const showsOutline = (headings: readonly OutlineHeading[]) =>
  headings.length >= OUTLINE_MINIMUM;

/**
 * The current heading: the last one at or above the reading line. `offsets` are
 * the headings' tops in the same unit as `line` (both measured from the top of
 * the scrolling column). Above the first heading, the first is current, so one
 * is always marked. None when there are no headings.
 */
export function currentHeading(
  offsets: readonly number[],
  line: number,
): number | null {
  if (offsets.length === 0) return null;
  let current = 0;
  offsets.forEach((offset, index) => {
    if (offset <= line) current = index;
  });
  return current;
}

/**
 * What the outline lists for the heading the reader is at: every section, and
 * under the section the reader is in, its subsections. The popover and the
 * full-width rail list the same.
 */
export function outlineView(
  headings: readonly OutlineHeading[],
  here: string | null,
) {
  const at = headings.findIndex((heading) => heading.id === here);
  // The section the reader is in: the last section at or above the current heading.
  let sectionAt = -1;
  headings.forEach((heading, index) => {
    if (heading.section && index <= at) sectionAt = index;
  });
  const next = headings.findIndex(
    (heading, index) => heading.section && index > sectionAt,
  );
  const shown = headings.filter((heading, index) =>
    heading.section ? true : index > sectionAt && (next === -1 || index < next),
  );
  const subsections = shown.filter((heading) => !heading.section).length;
  return { sectionAt, shown, subsections };
}

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

/**
 * The headings of what Read renders (h1 to h4), in order, each with an anchor.
 * A repeated heading gets "-1", "-2" and so on, so anchors never collide.
 */
export function outlineOf(source: string): OutlineHeading[] {
  const tree = parser.parse(source) as Node;
  const found: { level: 1 | 2 | 3 | 4; text: string; offset: number }[] = [];
  const walk = (node: Node) => {
    if (
      node.type === "heading" &&
      node.depth !== undefined &&
      node.depth <= 4 &&
      node.position?.start.offset !== undefined
    ) {
      found.push({
        level: node.depth as 1 | 2 | 3 | 4,
        text: plainText(node).trim(),
        offset: node.position.start.offset,
      });
      return;
    }
    node.children?.forEach(walk);
  };
  walk(tree);
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

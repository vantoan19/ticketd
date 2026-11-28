import type { RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { MarkdownBlockRange } from "@/features/markdown/block-ranges";
import { acceptanceSection } from "./acceptance-section";

const parser = unified().use(remarkParse).use(remarkGfm);
const FOLD_THRESHOLD = 2_600;
const OPENING_LENGTH = 1_100;

type Fold = MarkdownBlockRange & { label: string; id: string };

function foldLabel(blocks: readonly { node: RootContent; text: string }[]) {
  const headings = blocks
    .filter(({ node }) => node.type === "heading")
    .map(({ text }) => text);
  if (headings.length === 0) {
    const count = blocks.length;
    return `${count} more paragraph${count === 1 ? "" : "s"}`;
  }
  const count = headings.length;
  const named = headings.slice(0, 3);
  if (count > named.length) named.push(`+${count - named.length}`);
  return `${count} more section${count === 1 ? "" : "s"}: ${named.join(", ")}`;
}

/** Fold the two runs around acceptance, using offsets into the whole description. */
export function describeTicketMarkdown(markdown: string) {
  const acceptance = acceptanceSection(markdown);
  const folds: Fold[] = [];
  const blocks = parser.parse(markdown).children.flatMap((node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      start === undefined ||
      end === undefined ||
      node.type === "definition" ||
      node.type === "footnoteDefinition"
    )
      return [];
    const text = toString(node).replace(/\s+/g, " ").trim();
    return [{ node, start, end, text, length: Array.from(text).length }];
  });
  const length = blocks.reduce((sum, block) => sum + block.length, 0);
  if (length <= FOLD_THRESHOLD) return { acceptance, folds };

  let openingLength = 0;
  let openingEnd = 0;
  for (const block of blocks) {
    openingLength += block.length;
    if (block.node.type !== "heading") {
      // Keep the first complete block if even that block exceeds the budget.
      if (openingLength > OPENING_LENGTH && openingEnd > 0) break;
      openingEnd = block.end;
    }
    if (openingLength > OPENING_LENGTH) break;
  }
  const remainder = blocks.filter(({ start }) => start >= openingEnd);
  function addFold(id: string, hidden: typeof blocks) {
    const first = hidden[0];
    const last = hidden.at(-1);
    if (first && last)
      folds.push({
        id,
        start: first.start,
        end: last.end,
        label: foldLabel(hidden),
      });
  }
  if (acceptance) {
    addFold(
      "before-acceptance",
      remainder.filter(({ start }) => start < acceptance.start),
    );
    addFold(
      "after-acceptance",
      remainder.filter(({ start }) => start >= acceptance.end),
    );
  } else {
    addFold("remainder", remainder);
  }
  return { acceptance, folds };
}

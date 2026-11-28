import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * The first top-level acceptance section, with an inclusive start and exclusive
 * end in the Markdown string. A section with no checklist items still has a range.
 */
export function acceptanceSection(markdown: string) {
  const tree = parser.parse(markdown);
  const sectionIndex = tree.children.findIndex((block) => {
    if (block.type !== "heading") return false;
    const title = toString(block).trim().replace(/\s+/g, " ").toLowerCase();
    return (
      title.startsWith("acceptance") ||
      title === "how would you know it worked?"
    );
  });
  const heading = tree.children[sectionIndex];
  if (heading?.type !== "heading") return null;
  const start = heading.position?.start.offset;
  if (start === undefined) return null;

  const following = tree.children.slice(sectionIndex + 1);
  const nextSection = following.findIndex(
    (block) => block.type === "heading" && block.depth <= heading.depth,
  );
  const end = following[nextSection]?.position?.start.offset ?? markdown.length;

  let done = 0;
  let total = 0;
  const children =
    nextSection === -1 ? following : following.slice(0, nextSection);
  visit({ type: "root", children }, "listItem", (item) => {
    if (typeof item.checked !== "boolean") return;
    total += 1;
    if (item.checked) done += 1;
  });
  return { start, end, done, total };
}

import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import type { Nodes, Root } from "mdast";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    async: true,
    postprocess: {
      includeProcessedMarkdown: {
        headingIds: false,
        mdxAsPlaceholder: ["Card", "Callout"],
        filterElement: (node) =>
          node.type === "mdxJsxFlowElement" &&
          ["Steps", "Step", "Cards"].includes(node.name ?? "")
            ? "children-only"
            : true,
      },
    },
  },
});

// One syntax palette follows the same CSS tokens as the surrounding article.
const syntax = {
  name: "ticketd",
  type: "light" as const,
  colors: {
    "editor.foreground": "var(--ink)",
    "editor.background": "var(--paper-raised)",
  },
  tokenColors: [
    {
      scope: [
        "support.function",
        "entity.name.function",
        "support.type.property-name",
        "keyword.control",
      ],
      settings: { foreground: "var(--blue)" },
    },
    {
      scope: ["comment"],
      settings: { foreground: "var(--ink-soft)", fontStyle: "italic" },
    },
  ],
};

// The frontmatter title is each page's heading. An included repository file
// such as PRIVACY.md brings its own, which would repeat it.
function remarkDropTitle() {
  const drop = (node: Nodes) => {
    if (!("children" in node)) return;
    node.children = node.children.filter(
      (child) => child.type !== "heading" || child.depth !== 1,
    ) as typeof node.children;
    node.children.forEach(drop);
  };
  return (tree: Root) => drop(tree);
}

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkDropTitle],
    rehypeCodeOptions: { themes: { light: syntax, dark: syntax } },
  },
});

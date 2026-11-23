import { defineConfig, defineDocs } from "fumadocs-mdx/config";

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

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: { themes: { light: syntax, dark: syntax } },
  },
});

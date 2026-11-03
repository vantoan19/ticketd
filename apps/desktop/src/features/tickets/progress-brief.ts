import { unified } from "unified";
import remarkParse from "remark-parse";

const parser = unified().use(remarkParse);

/** A brief can contain Markdown; a compact row names its readable content. */
export function progressBrief(markdown: string): string {
  const parts: string[] = [];
  function collect(node: {
    type: string;
    value?: string;
    alt?: string | null;
    children?: unknown[];
  }) {
    if (
      node.type === "text" ||
      node.type === "inlineCode" ||
      node.type === "code"
    ) {
      if (node.value) parts.push(node.value);
    } else if (node.type === "image" && node.alt) {
      parts.push(node.alt);
    } else if (node.children) {
      for (const child of node.children) {
        if (
          typeof child === "object" &&
          child !== null &&
          "type" in child &&
          typeof child.type === "string"
        )
          collect(child as Parameters<typeof collect>[0]);
      }
    }
    if (
      ["paragraph", "heading", "listItem", "code", "break"].includes(node.type)
    )
      parts.push(" ");
  }
  collect(parser.parse(markdown));
  return parts.join("").replace(/\s+/g, " ").trim();
}

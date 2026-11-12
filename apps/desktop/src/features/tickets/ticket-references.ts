import { visit } from "unist-util-visit";
import type { Root, PhrasingContent } from "mdast";

/** A whole Ticket reference as a person types it: T-, a two-letter device code, a counter. */
export const typedReference = /^T-[A-Z]{2}[1-9]\d*$/i;

export function references() {
  return (tree: Root) => {
    visit(tree, "text", (node, index, parent) => {
      if (
        index === undefined ||
        !parent ||
        parent.type === "link" ||
        parent.type === "linkReference"
      )
        return;
      const matches = [
        ...node.value.matchAll(
          /(?<![\p{L}\p{N}_-])T-[A-Z]{2}[1-9]\d*(?![\p{L}\p{N}_-])/gu,
        ),
      ];
      if (!matches.length) return;
      const parts: PhrasingContent[] = [];
      let last = 0;
      for (const match of matches) {
        if (match.index > last)
          parts.push({
            type: "text",
            value: node.value.slice(last, match.index),
          });
        parts.push({
          type: "link",
          url: `ticketd:${match[0]}`,
          children: [{ type: "text", value: match[0] }],
        });
        last = match.index + match[0].length;
      }
      if (last < node.value.length)
        parts.push({ type: "text", value: node.value.slice(last) });
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}

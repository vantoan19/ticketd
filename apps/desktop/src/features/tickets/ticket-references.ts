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
      // "[[T-FV8]]" (a wiki-style reference) shows as the reference alone:
      // the brackets belong to the syntax, not the text (detA MK-10, detB DB-33).
      const matches = [
        ...node.value.matchAll(
          /(\[\[)?(?<![\p{L}\p{N}_-])(T-[A-Z]{2}[1-9]\d*)(?![\p{L}\p{N}_-])(\]\])?/gu,
        ),
      ];
      if (!matches.length) return;
      const parts: PhrasingContent[] = [];
      let last = 0;
      for (const match of matches) {
        const reference = match[2] ?? match[0];
        // Only a matched pair of brackets is dropped; a lone one stays text.
        const wrapped = Boolean(match[1] && match[3]);
        const start = match.index + (match[1] && !wrapped ? 2 : 0);
        const end =
          match.index + match[0].length - (match[3] && !wrapped ? 2 : 0);
        if (start > last)
          parts.push({ type: "text", value: node.value.slice(last, start) });
        parts.push({
          type: "link",
          url: `ticketd:${reference}`,
          children: [{ type: "text", value: reference }],
        });
        last = end;
      }
      if (last < node.value.length)
        parts.push({ type: "text", value: node.value.slice(last) });
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}

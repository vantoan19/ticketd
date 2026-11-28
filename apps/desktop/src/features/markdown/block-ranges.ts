import type { Element, Root } from "hast";

export type MarkdownBlockRange = { start: number; end: number };

/** Group whole top-level blocks after parsing, so references and positions stay document-wide. */
export function blockRanges(ranges: readonly MarkdownBlockRange[]) {
  return (tree: Root) => {
    const children: Root["children"] = [];
    let group: Element | undefined;
    for (const node of tree.children) {
      const offset = node.position?.start.offset;
      if (node.type === "text" && !node.value.trim()) {
        if (group) group.children.push(node);
        else children.push(node);
        continue;
      }
      const range =
        offset === undefined
          ? undefined
          : ranges.find(({ start, end }) => start <= offset && offset < end);
      if (!range || node.type !== "element") {
        group = undefined;
        children.push(node);
        continue;
      }
      if (group?.properties.dataRangeStart !== range.start) {
        group = {
          type: "element",
          tagName: "markdown-block-range",
          properties: { dataRangeStart: range.start },
          children: [],
        };
        children.push(group);
      }
      group.children.push(node);
    }
    tree.children = children;
  };
}

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: Record<string, unknown>;
};

/**
 * A remark plugin that marks a top-level paragraph holding only bold text
 * (`**What changed:**`) with `data-bold-only`. Replies use such a line as a
 * heading, and the Chat sets it like one. A list item's or quote's paragraph is
 * never marked: there the bold word is part of the item.
 */
export function boldOnly() {
  return (tree: Node) => {
    for (const block of tree.children ?? []) {
      if (block.type !== "paragraph") continue;
      const content = (block.children ?? []).filter(
        (child) => !(child.type === "text" && !child.value?.trim()),
      );
      if (content.length !== 1 || content[0]?.type !== "strong") continue;
      block.data = {
        ...block.data,
        hProperties: { dataBoldOnly: "" },
      };
    }
  };
}

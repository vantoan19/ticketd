type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const chunk = (value: string): Node => ({
  type: "chunk",
  data: { hName: "span", hProperties: { className: ["chat-chunk"] } },
  children: [{ type: "text", value }],
});

/**
 * A remark plugin for streamed text: the words from each of `starts` (source
 * offsets where a new chunk began) up to the next are wrapped in a
 * `.chat-chunk` span, which fades in. Words before the first start stay plain.
 * The starts only ever grow, so a chunk keeps its span, and its animation does
 * not replay, as more text arrives.
 */
export function chunkFade(starts: readonly number[]) {
  const chunkAt = (offset: number) =>
    starts.filter((start) => start <= offset).length;
  const walk = (parent: Node) => {
    if (!parent.children) return;
    parent.children = parent.children.flatMap((child): Node[] => {
      if (child.type !== "text" || child.value === undefined) {
        walk(child);
        return [child];
      }
      const text = child.value;
      const from = child.position?.start.offset;
      const to = child.position?.end.offset;
      if (from === undefined || to === undefined) return [child];
      // Escapes and entities make the source longer than the text: such a node
      // is not split and belongs to the chunk it starts in.
      const cuts =
        to - from === text.length
          ? starts.filter((start) => start > from && start < to)
          : [];
      const edges = [from, ...cuts, to];
      return edges.slice(0, -1).map((edge, index) => {
        const value =
          cuts.length === 0
            ? text
            : text.slice(edge - from, (edges[index + 1] ?? to) - from);
        return chunkAt(edge) === 0 ? { type: "text", value } : chunk(value);
      });
    });
  };
  return (tree: Node) => walk(tree);
}

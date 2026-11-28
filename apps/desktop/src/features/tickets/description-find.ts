export type DescriptionMatch = {
  block: HTMLElement;
  fold: string | undefined;
  range: Range;
};

/** Search rendered text, including formatting and closed folds, one block at a time. */
export function findDescription(root: HTMLElement, query: string) {
  const term = query.trim();
  if (!term) return [];
  const escaped = term
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const pattern = new RegExp(escaped, "giu");
  const matches: DescriptionMatch[] = [];
  const rendered = root.querySelector(".markdown-document");
  for (const section of Array.from(rendered?.children ?? [])) {
    const foldContent = section.querySelector<HTMLElement>(
      "[data-description-fold]",
    );
    const blocks = foldContent ? Array.from(foldContent.children) : [section];
    for (const block of blocks) {
      if (!(block instanceof HTMLElement)) continue;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const segments: { node: Text; start: number; end: number }[] = [];
      let text = "";
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node instanceof Text) || !node.length) continue;
        const start = text.length;
        text += node.data;
        segments.push({ node, start, end: text.length });
      }
      for (const match of text.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        const first = segments.find((segment) => segment.end > start);
        const last = segments.find((segment) => segment.end >= end);
        if (!first || !last) continue;
        const range = document.createRange();
        range.setStart(first.node, start - first.start);
        range.setEnd(last.node, end - last.start);
        matches.push({
          block,
          fold: foldContent?.dataset.descriptionFold,
          range,
        });
      }
    }
  }
  return matches;
}

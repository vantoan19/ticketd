// Width breakpoints for the large panes, in place of CSS container queries.
//
// WebKit restyles a query container's whole subtree whenever the container's
// size changes, whether or not any query flips. The panes resize on every frame
// the sidebar folds or a split is dragged, and the ticket workspace holds every
// row and the open document, so each frame restyled all of it: 13ms of forced
// layout per sidebar frame with 50 rows, against 2.5ms without the containers.
//
// So these panes are measured here instead. A ResizeObserver writes the
// breakpoints a pane's content box is within to its `data-width`, and only a
// change of that attribute restyles, a few times per sweep. A stylesheet writes
// `[data-width~="max-999"]` where it would write `@container (max-width: 999px)`
// and `[data-width~="min-760"]` for `(min-width: 760px)`. The panes keep the
// containment a query container has (`contain: inline-size layout style`), so
// their layout is unchanged. Small containers (the sidebar, pane headers, the
// chat tray) keep real container queries: restyling them is cheap.
//
// An unnamed container query resolves to the nearest container. Inner panes are
// never wider than the panes around them, so "some measured pane around it is
// within N" is the same test: `:where([data-width~="max-N"]) .part`.

/** Every element measured here. Keep in step with the stylesheets' `data-width` rules. */
export const WIDTH_PANES = [
  ".plan-workspace",
  ".plan-overview",
  ".ticket-list",
  ".ticket-detail",
  ".chat-pane",
  ".context-view-wrapper",
  ".attachment-workspace",
  ".cgraph-page",
  ".plan-dependencies",
].join(", ");

/** The `max-width` breakpoints the stylesheets use, in px (inclusive). */
const MAX = [
  400, 419, 420, 459, 460, 479, 509, 599, 600, 619, 640, 760, 799, 879, 999,
];
/** The `min-width` breakpoints the stylesheets use, in px (inclusive). */
const MIN = [760];

/** The `data-width` tokens for a content-box width; none while it has no size. */
export function widthTokens(width: number): string {
  if (width <= 0) return "";
  return [
    ...MAX.filter((max) => width <= max).map((max) => `max-${max}`),
    ...MIN.filter((min) => width >= min).map((min) => `min-${min}`),
  ].join(" ");
}

function write(element: Element, width: number) {
  const tokens = widthTokens(width);
  if (element.getAttribute("data-width") === tokens) return;
  if (tokens) element.setAttribute("data-width", tokens);
  else element.removeAttribute("data-width");
}

/**
 * Measure every pane under `root`, now and as panes mount; returns the function
 * that stops. A browser without ResizeObserver (the test DOM) gets no tokens,
 * as it would get no container query matches.
 */
export function installWidthQueries(root: ParentNode = document): () => void {
  if (
    typeof ResizeObserver === "undefined" ||
    typeof MutationObserver === "undefined"
  )
    return () => {};
  const observed = new Set<Element>();
  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) write(entry.target, entry.contentRect.width);
  });
  const add = (element: Element) => {
    if (observed.has(element)) return;
    observed.add(element);
    sizes.observe(element);
  };
  const scan = (node: ParentNode) => {
    if (node instanceof Element && node.matches(WIDTH_PANES)) add(node);
    for (const pane of node.querySelectorAll(WIDTH_PANES)) add(pane);
  };
  scan(root);
  const mounts = new MutationObserver((records) => {
    let removed = false;
    for (const record of records) {
      for (const node of record.addedNodes)
        if (node instanceof Element) scan(node);
      removed ||= record.removedNodes.length > 0;
      // A class added later (an element that becomes a pane) is a pane too.
      if (
        record.type === "attributes" &&
        record.target instanceof Element &&
        record.target.matches(WIDTH_PANES)
      )
        add(record.target);
    }
    if (!removed) return;
    for (const element of observed)
      if (!element.isConnected) {
        observed.delete(element);
        sizes.unobserve(element);
      }
  });
  mounts.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => {
    mounts.disconnect();
    sizes.disconnect();
    observed.clear();
  };
}

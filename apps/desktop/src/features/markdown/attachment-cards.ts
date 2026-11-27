import type { ExtraProps } from "react-markdown";

type Child = NonNullable<ExtraProps["node"]>["children"][number];
export type CardLink = {
  node: Child & { type: "element" };
  uri: string;
  /** What the author wrote, when it is more than the address itself. */
  label: string | undefined;
};

const ATTACHMENT = "ticketd://attachment/";

function textOf(node: Child): string {
  if (node.type === "text") return node.value;
  return node.type === "element" ? node.children.map(textOf).join("") : "";
}

/**
 * The attachment links of a paragraph or list item that holds nothing else
 * (blank space and line breaks apart): each stands alone on its line and
 * becomes a card. Null when anything else is there, or nothing is.
 */
export function cardLinks(node: ExtraProps["node"]): CardLink[] | null {
  if (!node) return null;
  const links: CardLink[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value.trim() === "") continue;
    if (child.type === "element" && child.tagName === "br") continue;
    const href =
      child.type === "element" && child.tagName === "a"
        ? child.properties.href
        : undefined;
    if (child.type !== "element" || typeof href !== "string") return null;
    if (!href.startsWith(ATTACHMENT)) return null;
    const label = textOf(child).trim();
    links.push({
      node: child,
      uri: href,
      label: label && label !== href ? label : undefined,
    });
  }
  return links.length ? links : null;
}

type Tree = {
  type: string;
  tagName?: string;
  value?: string;
  children?: Tree[];
};
const holdsCards = (node: Tree | undefined) =>
  node?.type === "element" &&
  (node.tagName === "p" || node.tagName === "li") &&
  cardLinks(node as unknown as ExtraProps["node"]) !== null;

function dropGaps(node: Tree) {
  if (!node.children) return;
  node.children.forEach(dropGaps);
  const siblings = node.children;
  node.children = siblings.filter(
    (child, index) =>
      !(
        child.type === "text" &&
        !child.value?.trim() &&
        holdsCards(siblings[index - 1]) &&
        holdsCards(siblings[index + 1])
      ),
  );
}

/**
 * A rehype plugin: the blank text the parser leaves between two blocks that
 * both hold cards is dropped, so the cards sit 12px apart (their grid's gap)
 * instead of 12px plus the width of a space.
 */
export function cardGaps() {
  return (tree: Tree) => dropGaps(tree);
}

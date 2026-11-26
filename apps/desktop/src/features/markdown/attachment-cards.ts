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

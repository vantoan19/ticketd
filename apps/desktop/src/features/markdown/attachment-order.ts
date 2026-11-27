import type { ExtraProps } from "react-markdown";

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** One file a document links or shows, with the element that does. */
export type PlaceMention = { uri: string; node: ExtraProps["node"] };
/** Filled each time the document is rendered; read when a viewer opens. */
export type PlaceMentions = { current: PlaceMention[] };

const ATTACHMENT = "ticketd://attachment/";

/**
 * A rehype plugin that records the attachments a document links or shows (a
 * card, a link in a sentence, a picture) in reading order, once per address:
 * the files Previous and Next walk. It changes nothing in the tree.
 */
export function attachmentOrder(into: PlaceMentions) {
  return (tree: HastNode) => {
    const found: PlaceMention[] = [];
    const seen = new Set<string>();
    const walk = (node: HastNode) => {
      if (node.type === "element") {
        const address =
          node.tagName === "a"
            ? node.properties?.href
            : node.tagName === "img"
              ? node.properties?.src
              : undefined;
        if (
          typeof address === "string" &&
          address.startsWith(ATTACHMENT) &&
          !seen.has(address)
        ) {
          seen.add(address);
          found.push({ uri: address, node: node as ExtraProps["node"] });
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    into.current = found;
  };
}

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/** Where a link to insert at `pos` goes: after the link `pos` is in, if any. */
export function linkInsertionPoint(state: EditorState, pos: number) {
  let node = syntaxTree(state).resolveInner(pos, -1);
  const linkNodes = ["Link", "Image", "Autolink"];
  while (node.parent && !linkNodes.includes(node.name)) node = node.parent;
  return linkNodes.includes(node.name) ? node.to : undefined;
}

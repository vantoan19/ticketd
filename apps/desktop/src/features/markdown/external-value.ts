import { TextApi, type Descendant, type Point, type Value } from "platejs";
import type { PlateEditor } from "platejs/react";

type Leaf = { path: number[]; length: number };

function leaves(nodes: readonly Descendant[], path: number[] = []): Leaf[] {
  return nodes.flatMap((node, index): Leaf[] => {
    const at = [...path, index];
    if (TextApi.isText(node)) return [{ path: at, length: node.text.length }];
    return leaves(node.children, at);
  });
}

function text(nodes: readonly Descendant[]): string {
  return nodes
    .map((node) => (TextApi.isText(node) ? node.text : text(node.children)))
    .join("");
}

function offsetOf(nodes: readonly Descendant[], point: Point): number | null {
  let offset = 0;
  for (const leaf of leaves(nodes)) {
    if (leaf.path.join(".") === point.path.join("."))
      return offset + Math.min(point.offset, leaf.length);
    offset += leaf.length;
  }
  return null;
}

function pointAt(nodes: readonly Descendant[], offset: number): Point | null {
  const all = leaves(nodes);
  let remaining = offset;
  for (const leaf of all) {
    if (remaining <= leaf.length) return { path: leaf.path, offset: remaining };
    remaining -= leaf.length;
  }
  const last = all.at(-1);
  return last ? { path: last.path, offset: last.length } : null;
}

/** Where a caret at `offset` of `before` lands in `after`, keeping it beside the text it was in. */
export function mapOffset(before: string, after: string, offset: number) {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;
  if (offset <= prefix) return offset;
  if (offset >= before.length - suffix)
    return after.length - (before.length - offset);
  return Math.min(offset, after.length - suffix);
}

/** Replaces the editor content with an outside change without moving the caret off its text. */
export function applyExternalValue(editor: PlateEditor, next: Value) {
  const selection = editor.selection;
  const before = editor.children;
  const anchor = selection ? offsetOf(before, selection.anchor) : null;
  const focus = selection ? offsetOf(before, selection.focus) : null;
  const beforeText = text(before);
  editor.tf.setValue(next);
  if (anchor === null || focus === null) return;
  const afterText = text(editor.children);
  const to = pointAt(editor.children, mapOffset(beforeText, afterText, anchor));
  const from = pointAt(
    editor.children,
    mapOffset(beforeText, afterText, focus),
  );
  if (to && from) editor.tf.select({ anchor: to, focus: from });
}

import { TextApi, type Descendant, type Point, type Value } from "platejs";
import type { PlateEditor } from "platejs/react";

type Selection = NonNullable<PlateEditor["selection"]>;

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
  // A caret inside the replaced text lands at the end of it. Whole words count as replaced, so
  // a few letters the old and new text happen to share ("...short." vs "...it.") do not
  // leave the caret inside a word.
  let whole = suffix;
  while (whole > 0 && !/\s/.test(after[after.length - whole - 1] ?? " "))
    whole -= 1;
  return Math.min(offset, after.length - whole);
}

function blockTexts(nodes: readonly Descendant[]) {
  return nodes.map((node) => text([node]));
}

/** Maps a (block, offset) caret to the matching block of `after`, never leaving that block. */
export function mapBlockCaret(
  before: readonly string[],
  after: readonly string[],
  block: number,
  offset: number,
): { block: number; offset: number } {
  let head = 0;
  const shortest = Math.min(before.length, after.length);
  while (head < shortest && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < shortest - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail += 1;
  if (block < head) return { block, offset };
  if (block >= before.length - tail)
    return { block: block + after.length - before.length, offset };
  const target = Math.max(
    0,
    Math.min(block, after.length - 1, after.length - tail - 1),
  );
  const mapped = mapOffset(before[block] ?? "", after[target] ?? "", offset);
  return {
    block: target,
    offset: Math.min(mapped, (after[target] ?? "").length),
  };
}

function caretOf(nodes: readonly Descendant[], point: Point) {
  const block = point.path[0];
  const node = block === undefined ? undefined : nodes[block];
  if (block === undefined || !node) return null;
  const inner = offsetOf([node], {
    path: [0, ...point.path.slice(1)],
    offset: point.offset,
  });
  return inner === null ? null : { block, offset: inner };
}

function pointIn(
  nodes: readonly Descendant[],
  caret: { block: number; offset: number },
): Point | null {
  const node = nodes[caret.block];
  if (!node) return null;
  const point = pointAt([node], caret.offset);
  return point
    ? { path: [caret.block, ...point.path.slice(1)], offset: point.offset }
    : null;
}

/** Replaces the editor content with an outside change without moving the caret off its text. */
export function applyExternalValue(
  editor: PlateEditor,
  next: Value,
  remembered?: Selection | null,
) {
  const selection = editor.selection ?? remembered ?? null;
  const before = editor.children;
  const anchor = selection ? caretOf(before, selection.anchor) : null;
  const focus = selection ? caretOf(before, selection.focus) : null;
  const beforeBlocks = blockTexts(before);
  editor.tf.setValue(next);
  const afterBlocks = blockTexts(editor.children);
  // Never leave the editor without a selection once it had one: fall back to the end.
  const fallback = (): Point | null => {
    const last = editor.children.length - 1;
    return pointIn(editor.children, {
      block: last,
      offset: (afterBlocks[last] ?? "").length,
    });
  };
  if (!anchor || !focus) return;
  const map = (c: { block: number; offset: number }) => {
    const m = mapBlockCaret(beforeBlocks, afterBlocks, c.block, c.offset);
    return pointIn(editor.children, m) ?? fallback();
  };
  const to = map(anchor);
  const from = map(focus);
  if (to && from) editor.tf.select({ anchor: to, focus: from });
}

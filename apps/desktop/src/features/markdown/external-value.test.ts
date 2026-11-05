import { createPlateEditor } from "platejs/react";
import { describe, expect, it } from "vitest";
import { applyExternalValue, mapOffset } from "./external-value";

const paragraphs = (...lines: string[]) =>
  lines.map((line) => ({ type: "p", children: [{ text: line }] }));

describe("external value while editing", () => {
  it("keeps the caret in the same text when an earlier block changes", () => {
    const editor = createPlateEditor({ value: paragraphs("first", "second") });
    editor.tf.select({ path: [1, 0], offset: 3 });
    applyExternalValue(editor, paragraphs("first line added", "second"));
    expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 3 });
    editor.tf.insertText("X");
    expect(editor.children[1]).toMatchObject({
      children: [{ text: "secXond" }],
    });
  });
  it("keeps the caret at the end when text is appended elsewhere", () => {
    const editor = createPlateEditor({ value: paragraphs("hello") });
    editor.tf.select({ path: [0, 0], offset: 5 });
    applyExternalValue(editor, paragraphs("hello", "from the CLI"));
    expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 5 });
  });
  it("maps offsets around the changed span", () => {
    expect(mapOffset("abcXYZdef", "abc12345def", 2)).toBe(2);
    expect(mapOffset("abcXYZdef", "abc12345def", 8)).toBe(10);
    expect(mapOffset("abcXYZdef", "abc12345def", 4)).toBe(4);
  });
});

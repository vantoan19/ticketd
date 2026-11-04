import { createPlateEditor } from "platejs/react";
import { describe, expect, it } from "vitest";
import { CodeBlockPlugin } from "@platejs/code-block/react";
import { BulletedListRules } from "@platejs/list-classic";
import { ListPlugin } from "@platejs/list-classic/react";
import { checklistRule, closeCodeFence, openFenceRule } from "./input-rules";
import { writeMarkdown } from "./plate-markdown";

const richPlugins = [
  ListPlugin.configure({
    inputRules: [BulletedListRules.markdown(), checklistRule],
  }),
  CodeBlockPlugin.configure({ inputRules: [openFenceRule] }),
];

function typing(initial: string, keys: (string | "\n")[]) {
  const editor = createPlateEditor({
    plugins: richPlugins,
    value: [{ type: "p", children: [{ text: initial }] }],
  });
  editor.tf.select(editor.api.end([])!);
  for (const key of keys) {
    if (key === "\n") {
      if (!closeCodeFence(editor)) editor.tf.insertBreak();
    } else editor.tf.insertText(key);
  }
  return editor;
}

describe("typed Markdown input rules", () => {
  it("opens a code block with its language and closes it with a fence line", () => {
    const editor = typing("", [
      ..."```js",
      "\n",
      ..."let a",
      "\n",
      ..."```",
      "\n",
      ..."after",
    ]);
    expect(writeMarkdown(editor.children)).toBe("```js\nlet a\n```\n\nafter");
  });
  it("turns '- [ ] ' into a checklist item", () => {
    const editor = typing("", [..."- [ ] task"]);
    expect(writeMarkdown(editor.children)).toBe("- [ ] task");
    const checked = typing("", [..."- [x] done"]);
    expect(writeMarkdown(checked.children)).toBe("- [x] done");
  });
});

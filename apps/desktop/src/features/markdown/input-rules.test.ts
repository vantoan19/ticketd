import { createPlateEditor } from "platejs/react";
import { describe, expect, it, vi } from "vitest";
import { documents } from "@/features/documents/api";
import { CodeBlockPlugin } from "@platejs/code-block/react";
import { BulletedListRules } from "@platejs/list-classic";
import { ListPlugin } from "@platejs/list-classic/react";
import { LinkPlugin } from "@platejs/link/react";
import {
  checklistRule,
  closeCodeFence,
  markdownLinkRule,
  openFenceRule,
} from "./input-rules";
import { linkPluginOptions } from "./link-options";
import { writeMarkdown } from "./plate-markdown";

vi.mock("@/features/documents/api", () => ({
  documents: { show: vi.fn(() => Promise.reject(new Error("offline"))) },
}));

const richPlugins = [
  ListPlugin.configure({
    inputRules: [BulletedListRules.markdown(), checklistRule],
  }),
  CodeBlockPlugin.configure({ inputRules: [openFenceRule] }),
  LinkPlugin.configure({
    options: linkPluginOptions,
    inputRules: [markdownLinkRule],
  }),
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
  it("turns a typed [text](url) into a link on the closing parenthesis", () => {
    const editor = typing("", [..."see [docs](https://example.com/a) now"]);
    expect(writeMarkdown(editor.children)).toBe(
      "see [docs](https://example.com/a) now",
    );
    expect(JSON.stringify(editor.children)).toContain('"type":"a"');
    const ticketd = typing("", [..."[](ticketd://document/abc)"]);
    expect(writeMarkdown(ticketd.children)).toBe("<ticketd://document/abc>");
  });
  it("leaves other targets as typed", () => {
    const editor = typing("", [..."[x](javascript:alert)"]);
    expect(JSON.stringify(editor.children)).not.toContain('"type":"a"');
  });
  it("labels an unlabelled Document link with the Document heading", async () => {
    vi.mocked(documents.show).mockResolvedValueOnce({
      heading: "Plan notes",
    } as never);
    const editor = typing("", [..."[](ticketd://document/abc)"]);
    await vi.waitFor(() =>
      expect(writeMarkdown(editor.children)).toBe(
        "[Plan notes](ticketd://document/abc)",
      ),
    );
  });
});

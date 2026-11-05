import { upsertLink } from "@platejs/link";
import { LinkPlugin } from "@platejs/link/react";
import { createPlateEditor } from "platejs/react";
import { expect, it } from "vitest";
import { linkPluginOptions } from "./link-options";
import { writeMarkdown } from "./plate-markdown";

it("inserts a ticketd:// Document link as Markdown", () => {
  const editor = createPlateEditor({
    plugins: [LinkPlugin.configure({ options: linkPluginOptions })],
    value: [{ type: "p", children: [{ text: "Design notes" }] }],
  });
  editor.tf.select({
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: 12 },
  });
  upsertLink(editor, { url: "ticketd://document/doc-1" });
  expect(writeMarkdown(editor.children)).toContain(
    "[Design notes](ticketd://document/doc-1)",
  );
});

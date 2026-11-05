import { PathApi, defineInputRule, type TElement } from "platejs";
import type { PlateEditor } from "platejs/react";
import { toggleTaskList } from "@platejs/list-classic";
import { upsertLink } from "@platejs/link";
import { documents } from "@/features/documents/api";

function isInCodeBlock(editor: PlateEditor) {
  return editor.api.some({ match: { type: "code_block" } });
}

/** "```lang" + Enter opens a code block with that language. */
export const openFenceRule = defineInputRule({
  target: "insertBreak",
  priority: 100,
  enabled: ({ editor }) => !isInCodeBlock(editor),
  resolve: (context) => {
    const { editor } = context;
    const entry = context.getBlockEntry();
    if (!context.isCollapsed || !editor.selection || entry?.[0].type !== "p")
      return;
    const path = entry[1];
    if (!editor.api.isEnd(editor.selection.focus, path)) return;
    const match = /^```([^\s`]*)$/.exec(editor.api.string(path));
    return match ? { path, lang: match[1] ?? "" } : undefined;
  },
  apply: ({ editor }, match) => {
    editor.tf.removeNodes({ at: match.path });
    editor.tf.insertNodes(
      {
        type: "code_block",
        lang: match.lang,
        children: [{ type: "code_line", children: [{ text: "" }] }],
      },
      { at: match.path },
    );
    const start = editor.api.start([...match.path, 0]);
    if (start) editor.tf.select(start);
    return true;
  },
});

/**
 * A line that is only "```" + Enter closes the code block instead of adding text to it. This runs
 * from the key handler because the code block's own Enter handling wraps Plate's input rules.
 */
export function closeCodeFence(editor: PlateEditor): boolean {
  const entry = editor.api.block();
  if (
    !editor.selection ||
    !editor.api.isCollapsed() ||
    entry?.[0].type !== "code_line"
  )
    return false;
  const path = entry[1];
  if (
    editor.api.string(path).trim() !== "```" ||
    !editor.api.isEnd(editor.selection.focus, path)
  )
    return false;
  const blockPath = PathApi.parent(path);
  const block = editor.api.node<TElement>(blockPath)?.[0];
  let target = PathApi.next(blockPath);
  if (block && block.children.length > 1) {
    editor.tf.removeNodes({ at: path });
  } else {
    editor.tf.removeNodes({ at: blockPath });
    target = blockPath;
  }
  editor.tf.insertNodes(
    { type: "p", children: [{ text: "" }] },
    { at: target },
  );
  const start = editor.api.start(target);
  if (start) editor.tf.select(start);
  return true;
}

/** "[ ] ", "[x] " or "[] " at the start of a block, including a list item, makes a checklist item. */
export const checklistRule = defineInputRule({
  target: "insertText",
  trigger: " ",
  enabled: ({ editor }) => !isInCodeBlock(editor),
  resolve: (context) => {
    const range = context.getBlockStartRange();
    const match = /^\[([ xX]?)\]$/.exec(context.getBlockStartText() ?? "");
    if (!context.isCollapsed || !range || !match) return;
    return { range, checked: /x/i.test(match[1] ?? "") };
  },
  apply: ({ editor }, match) => {
    editor.tf.delete({ at: match.range });
    const item = editor.api.above({ match: { type: "li" } });
    if (item) {
      // A list is either all checklist items or none, so the whole list converts.
      const listPath = PathApi.parent(item[1]);
      editor.tf.setNodes({ type: "taskList" }, { at: listPath });
      for (const [index, sibling] of (
        editor.api.node<TElement>(listPath)?.[0].children ?? []
      ).entries()) {
        const at = [...listPath, index];
        if (at.join() === item[1].join())
          editor.tf.setNodes({ checked: match.checked }, { at });
        else if (typeof (sibling as TElement).checked !== "boolean")
          editor.tf.setNodes({ checked: false }, { at });
      }
    } else toggleTaskList(editor, match.checked);
    return true;
  },
});

/**
 * Typing the closing ")" of "[text](url)" turns it into a link, for http(s) and ticketd:// targets.
 * Without text the link reads as its URL.
 */
export const markdownLinkRule = defineInputRule({
  target: "insertText",
  trigger: ")",
  enabled: ({ editor }) => !isInCodeBlock(editor),
  resolve: ({ editor, isCollapsed }) => {
    const focus = editor.selection?.focus;
    if (!isCollapsed || !focus) return;
    const block = editor.api.block();
    if (!block) return;
    const start = editor.api.start(block[1]);
    if (!start) return;
    const before = editor.api.string({ anchor: start, focus });
    const match =
      /\[([^[\]]*)\]\(((?:https?:\/\/|ticketd:\/\/)[^\s()]+)$/i.exec(before);
    if (!match) return;
    const length = match[0].length;
    const anchor = editor.api.before(focus, {
      distance: length,
      unit: "character",
    });
    if (!anchor) return;
    return {
      range: { anchor, focus },
      text: match[1] ?? "",
      url: match[2] ?? "",
    };
  },
  apply: ({ editor }, match) => {
    editor.tf.delete({ at: match.range });
    upsertLink(editor, { url: match.url, text: match.text || match.url });
    const documentId = /^ticketd:\/\/document\/([^/?#\s]+)$/i.exec(
      match.url,
    )?.[1];
    if (!match.text && documentId)
      void labelWithHeading(editor, match.url, documentId);
    return true;
  },
});

/** An unlabelled Document link reads as the Document's heading; the URL stays if the lookup fails. */
async function labelWithHeading(
  editor: PlateEditor,
  url: string,
  documentId: string,
) {
  let heading: string | undefined;
  try {
    heading = (await documents.show(documentId)).heading;
  } catch {
    return;
  }
  if (!heading) return;
  const entry = editor.api.node<TElement>({
    at: [],
    match: (node) =>
      "type" in node &&
      node.type === "a" &&
      (node as { url?: string }).url === url &&
      (node as TElement).children.length === 1 &&
      ((node as TElement).children[0] as { text?: string }).text === url,
  });
  if (!entry) return;
  const [, path] = entry;
  editor.tf.withoutNormalizing(() => {
    editor.tf.insertNodes({ text: heading }, { at: [...path, 1] });
    editor.tf.removeNodes({ at: [...path, 0] });
  });
}

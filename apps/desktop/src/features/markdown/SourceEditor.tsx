import { useMemo, type Ref } from "react";
import CodeMirror, {
  type ReactCodeMirrorProps,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { Prec } from "@codemirror/state";
import {
  HighlightStyle,
  LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { commonmarkLanguage } from "@codemirror/lang-markdown";
import { EditorView, keymap } from "@codemirror/view";

// CodeMirror lives in this module so it loads in its own chunk, on first use.

// Source colours come from the --syntax-* tokens, so light and dark each get their
// own palette (CodeMirror's default style is light only). Headings are not underlined:
// only links look like links.
const sourceHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--syntax-title)", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--link-foreground)" },
  { tag: tags.labelName, color: "var(--syntax-keyword)" },
  { tag: [tags.monospace, tags.string], color: "var(--syntax-string)" },
  { tag: [tags.escape, tags.character], color: "var(--syntax-number)" },
  {
    tag: [
      tags.processingInstruction,
      tags.comment,
      tags.contentSeparator,
      tags.quote,
    ],
    color: "var(--syntax-comment)",
  },
]);

// Source mode keeps what is typed: Enter inserts a plain newline, so list markers are not
// doubled and a closing fence never inherits indentation.
const sourceExtensions = [
  // CommonMark alone: markdown()'s defaults add the HTML, CSS and JS parsers.
  new LanguageSupport(commonmarkLanguage),
  syntaxHighlighting(sourceHighlight),
  EditorView.lineWrapping,
  Prec.highest(
    keymap.of([
      {
        key: "Enter",
        run: (view) => {
          view.dispatch(view.state.replaceSelection("\n"), {
            scrollIntoView: true,
            userEvent: "input",
          });
          return true;
        },
      },
    ]),
  ),
];

export type SourceEditorProps = Omit<
  ReactCodeMirrorProps,
  "extensions" | "theme"
> & {
  ref?: Ref<ReactCodeMirrorRef>;
  /** Names the editable text itself, beside the wrapper's `aria-label`. */
  contentLabel?: string;
};

/** Markdown source editing, highlighted with the theme's syntax tokens. */
export function SourceEditor({ contentLabel, ...props }: SourceEditorProps) {
  const extensions = useMemo(
    () =>
      contentLabel === undefined
        ? sourceExtensions
        : [
            ...sourceExtensions,
            EditorView.contentAttributes.of({ "aria-label": contentLabel }),
          ],
    [contentLabel],
  );
  return <CodeMirror {...props} theme="none" extensions={extensions} />;
}

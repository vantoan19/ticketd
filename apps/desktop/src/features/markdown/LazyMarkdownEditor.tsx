import { lazy, Suspense } from "react";
import type { MarkdownEditorProps } from "./MarkdownEditor";

const Editor = lazy(() =>
  import("./MarkdownEditor").then((module) => ({
    default: module.MarkdownEditor,
  })),
);

/** Load rich editing only when a production authoring surface is opened. */
export function LazyMarkdownEditor(props: MarkdownEditorProps) {
  return (
    <Suspense
      fallback={
        // Holds the editor's footprint so the form does not jump when it loads.
        <div role="status" className="markdown-editor min-h-32">
          <span className="sr-only">
            Loading {props.label?.toLowerCase() ?? "document"} editor…
          </span>
        </div>
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}

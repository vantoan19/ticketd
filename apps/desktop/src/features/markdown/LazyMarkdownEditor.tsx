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
        <p role="status">
          Loading {props.label?.toLowerCase() ?? "document"} editor…
        </p>
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}

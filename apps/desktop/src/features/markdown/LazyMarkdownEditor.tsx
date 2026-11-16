import { lazy, Suspense } from "react";
import { MarkdownDocument } from "./MarkdownDocument";
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
        props.chrome === "floating" ? (
          <section
            className="markdown-editor"
            data-chrome="floating"
            aria-label={props.label}
          >
            <div className="rich-document">
              <MarkdownDocument source={props.value} />
            </div>
            <span className="sr-only" role="status">
              Loading editor…
            </span>
          </section>
        ) : (
          <div role="status" className="markdown-editor min-h-32">
            <span className="sr-only">
              Loading {props.label?.toLowerCase() ?? "document"} editor…
            </span>
          </div>
        )
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}

import { useState, type ReactNode } from "react";
import {
  AttachmentPreview,
  type ReferenceReplacement,
} from "./AttachmentPreview";

/** An authored inline label. Opening captures the exact selected reference. */
export function AttachmentLink({
  uri,
  children,
  onReplace,
}: {
  uri: string;
  children: ReactNode;
  onReplace?: ReferenceReplacement | undefined;
}) {
  const [preview, setPreview] = useState<{
    uri: string;
    replace: typeof onReplace;
  } | null>(null);
  return (
    <>
      <button
        type="button"
        className="context-link"
        onClick={() => setPreview({ uri, replace: onReplace })}
      >
        {children}
      </button>
      {preview && (
        <AttachmentPreview
          target={{ uri: preview.uri }}
          onClose={() => setPreview(null)}
          onReplace={preview.replace}
        />
      )}
    </>
  );
}

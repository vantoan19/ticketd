import type { ReactNode } from "react";
import { FileIcon } from "./AttachmentThumbnail";
import type { FileFamily } from "./file-words";

/**
 * One state of the viewer's stage: a 112 × 72 tile, a title, one sentence and
 * a reserved 32px row for the state's fix or progress. Every state uses the
 * same block, so nothing shifts when a file moves from one state to the next.
 */
export function PreviewState({
  family,
  title,
  sentence,
  action,
  role,
}: {
  family: FileFamily;
  title: string;
  sentence: string;
  action?: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className="attachment-state" role={role}>
      <span className="attachment-state-tile" aria-hidden="true">
        <FileIcon family={family} />
      </span>
      <p className="attachment-state-title">{title}</p>
      <p className="attachment-state-sentence">{sentence}</p>
      <div className="attachment-state-action">{action}</div>
    </div>
  );
}

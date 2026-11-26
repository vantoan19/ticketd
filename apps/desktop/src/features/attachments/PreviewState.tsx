import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FailureDetails } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { FileIcon } from "./AttachmentThumbnail";
import type { FileFamily } from "./file-words";

/**
 * One state of the viewer's stage: a 112 × 72 tile (the family glyph over the
 * extension), a title, one sentence and a 32px row for the state's fix or
 * progress. Every state uses the same block from the same top, so the tile
 * stays put when a file moves from one state to the next; the row follows the
 * sentence, one line or two.
 */
export function PreviewState({
  family,
  label,
  title,
  attention = false,
  sentence,
  action,
  extra,
  role,
  busy,
}: {
  family: FileFamily;
  /** The tile's word: the extension ("HTML"), or "DRIVE ↗" for a reference. */
  label: string;
  title: string;
  /** The attention dot before the title: the person has to do something. */
  attention?: boolean;
  sentence: string;
  action?: ReactNode;
  /** Anything more a state must say, under the action row. */
  extra?: ReactNode;
  role?: "status" | "alert";
  busy?: boolean;
}) {
  return (
    <div className="attachment-state" role={role} aria-busy={busy}>
      <span className="attachment-state-tile" aria-hidden="true">
        <FileIcon family={family} />
        <span className="attachment-state-label">{label}</span>
      </span>
      <h3 className="attachment-state-title">
        {attention && (
          <span className="attachment-state-dot" aria-hidden="true" />
        )}
        {title}
      </h3>
      <p className="attachment-state-sentence">{sentence}</p>
      <div className="attachment-state-action">{action}</div>
      {extra}
    </div>
  );
}

/** The fix of a failure that can pass: Retry, then Details with the raw text. */
export function RetryActions({
  onRetry,
  details = "",
  disabled = false,
}: {
  onRetry: () => void;
  details?: string;
  disabled?: boolean;
}) {
  return (
    <>
      <Button variant="outline" size="sm" disabled={disabled} onClick={onRetry}>
        Retry
      </Button>
      <FailureDetails details={details} />
    </>
  );
}

/**
 * What the stage shows while the file is read, once it is slow enough to
 * notice: a placeholder shaped like the file, on the stage's final surface.
 * A page (PDF) is a paper rectangle with a few bars; anything else a block.
 */
export function PreviewLoading({
  shape = "block",
}: {
  shape?: "block" | "page";
}) {
  return (
    <div
      role="status"
      aria-label="Loading preview"
      className="attachment-preview-loading"
      data-shape={shape}
    >
      {shape === "page" ? (
        <span className="attachment-loading-page" aria-hidden="true">
          <i style={{ width: "52%", height: 16 }} />
          <i style={{ width: "100%", height: 9 }} />
          <i style={{ width: "94%", height: 9 }} />
          <i style={{ width: "72%", height: 9 }} />
          <i style={{ width: "100%", height: 64, marginTop: 6 }} />
        </span>
      ) : (
        <Skeleton className="h-full w-full" />
      )}
    </div>
  );
}

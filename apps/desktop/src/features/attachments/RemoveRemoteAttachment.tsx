import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  attachments,
  type Attachment,
  type AttachmentCleanupReview,
} from "@/lib/api/attachments";
import { usageContext } from "./usage-context";

export function RemoveRemoteAttachment({
  file,
  onClose,
  onChanged,
}: {
  file: Attachment;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [review, setReview] = useState<AttachmentCleanupReview | null>(null);
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof attachments.removeRemote>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let current = true;
    void attachments
      .cleanupReview(file.id)
      .then((value) => {
        if (current) setReview(value);
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [file.id]);
  async function remove() {
    setBusy(true);
    setError("");
    try {
      setResult(await attachments.removeRemote(file.id, requestId));
      onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="attachment-cleanup-dialog"
        showCloseButton={!busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="pr-6">
            {result ? "Removed from ticketd" : "Remove from ticketd?"}
          </DialogTitle>
          <DialogDescription>
            The original file will stay in Google Drive.
          </DialogDescription>
        </DialogHeader>
        <p>
          <strong>{file.display_name}</strong>
        </p>
        <p className="attachment-hint">
          Only the record is removed from ticketd. Drive files are never
          deleted, including copies uploaded by ticketd. No provider storage is
          reclaimed.
        </p>
        {result ? (
          <>
            <p role="status">
              The file remains in Drive. Choose it again in the Google Drive
              picker to re-add it.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                void attachments
                  .openRemovedRemote(result.open_url)
                  .catch((reason: unknown) => setError(String(reason)));
              }}
            >
              Open in Drive
            </Button>
          </>
        ) : (
          <>
            {!review && !error && <p role="status">Checking protections…</p>}
            {review && !review.remove_eligible && (
              <p role="alert">
                {review.usage.protections.length
                  ? `Protected · ${usageContext(review.usage)}`
                  : review.usage.legacy_drafts_pending
                    ? "Review recoverable drafts in all profiles first."
                    : review.reason}
              </p>
            )}
          </>
        )}
        {error && (
          <>
            <p role="alert">
              {result
                ? "Could not open the Drive file. Its ticketd record was removed; use the retained link or find it in Drive."
                : "Removal was not confirmed. Retry the same action or review usage again; the Drive file remains."}
            </p>
            <details>
              <summary>Details</summary>
              <p className="attachment-hint">{error}</p>
            </details>
          </>
        )}
        <div className="attachment-actions attachment-cleanup-footer">
          <Button
            ref={cancel}
            variant="ghost"
            disabled={busy}
            onClick={onClose}
          >
            {result ? "Done" : "Cancel"}
          </Button>
          {!result && (
            <Button
              disabled={busy || !review?.remove_eligible}
              onClick={() => void remove()}
            >
              {busy ? "Removing record…" : "Remove from ticketd"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

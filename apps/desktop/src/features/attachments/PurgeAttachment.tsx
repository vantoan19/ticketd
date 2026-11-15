import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
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
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { formatSize } from "./format-size";
import { usageContext } from "./usage-context";

export function PurgeAttachment({
  file,
  onClose,
  onChanged,
}: {
  file: Attachment;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [review, setReview] = useState<AttachmentCleanupReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const pending = (review?.attachment ?? file).purge_state === "pending";
  useEffect(() => {
    let current = true;
    void attachments
      .cleanupReview(file.id)
      .then((value) => {
        if (current) setReview(value);
      })
      .catch((reason: unknown) => {
        if (current)
          setError(describeFailure(reason, "check the file's protections"));
      });
    return () => {
      current = false;
    };
  }, [file.id]);
  async function purge() {
    setBusy(true);
    setError(null);
    try {
      await attachments.purge(file.id);
      onClose();
    } catch (reason) {
      try {
        setReview(await attachments.cleanupReview(file.id));
      } catch {
        // Keep the original failure and allow the same explicit action to retry.
      }
      setError(describeFailure(reason, "purge the file"));
    } finally {
      setBusy(false);
      onChanged();
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
        className="sm:max-w-170 max-h-dvh overflow-y-auto"
        showCloseButton={!busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="mr-6">
            Permanently purge this file?
          </DialogTitle>
          <DialogDescription>
            {pending
              ? "This permanent purge is pending. Retry to finish deletion and confirm completion; it cannot be undone."
              : "This removes quarantined local bytes and cannot be undone. Quarantine can be restored until you confirm permanent purge."}
          </DialogDescription>
        </DialogHeader>
        <p>
          <strong>{file.display_name}</strong>
          {file.size_bytes != null ? ` · ${formatSize(file.size_bytes)}` : ""}
        </p>
        <p className="attachment-hint">
          Its name and identity remain, but links and Undo cannot recover purged
          bytes. Existing backups are unchanged; recovery requires deliberately
          restoring an older complete backup. Remote files are never deleted.
        </p>
        {!review && !error && <p role="status">Checking protections…</p>}
        {review && !review.purge_eligible && (
          <p role="alert">
            {review.usage.protections.length
              ? `Protected · ${usageContext(review.usage)}`
              : review.reason}
          </p>
        )}
        {error && (
          <FailureAlert
            size="compact"
            failure={
              pending
                ? {
                    ...error,
                    sentence:
                      "The purge is still pending. Retry to finish it or confirm it completed.",
                  }
                : error
            }
          />
        )}
        <div className="attachment-actions attachment-cleanup-footer">
          <Button
            ref={cancel}
            variant="ghost"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !review?.purge_eligible}
            onClick={() => void purge()}
          >
            {busy
              ? "Purging file…"
              : pending
                ? "Retry permanent purge"
                : "Permanently purge file"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

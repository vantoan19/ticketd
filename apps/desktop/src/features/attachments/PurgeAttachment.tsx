import { useEffect, useState } from "react";
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
  const [error, setError] = useState("");
  const pending = (review?.attachment ?? file).purge_state === "pending";
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
  async function purge() {
    setBusy(true);
    setError("");
    try {
      await attachments.purge(file.id);
      onClose();
    } catch (reason) {
      setError(String(reason));
      try {
        setReview(await attachments.cleanupReview(file.id));
      } catch {
        // Keep the original failure and allow the same explicit action to retry.
      }
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
        className="attachment-cleanup-dialog"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Permanently purge this file?</DialogTitle>
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
        {error && <p role="alert">{error}</p>}
        <div className="attachment-actions attachment-cleanup-footer">
          <Button autoFocus variant="ghost" disabled={busy} onClick={onClose}>
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

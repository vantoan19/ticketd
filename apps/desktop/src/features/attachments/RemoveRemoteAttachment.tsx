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
import { usageContext } from "./usage-context";

export function RemoveRemoteAttachment({
  file,
  onClose,
  onChanged,
  onRemovedFocus,
}: {
  file: Attachment;
  onClose: () => void;
  onChanged: () => void;
  onRemovedFocus?: () => void;
}) {
  const [review, setReview] = useState<AttachmentCleanupReview | null>(null);
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof attachments.removeRemote>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
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
        if (current)
          setError(describeFailure(reason, "check where the file is used"));
      });
    return () => {
      current = false;
    };
  }, [file.id]);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      setResult(await attachments.removeRemote(file.id, requestId));
      onChanged();
    } catch (reason) {
      const failure = describeFailure(reason, "remove the file from ticketd");
      setError({
        ...failure,
        sentence: `${failure.sentence} The Drive file stays in Drive.`,
      });
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
        className="sm:max-w-170 max-h-dvh overflow-y-auto"
        showCloseButton={!busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (result && onRemovedFocus) {
            event.preventDefault();
            onRemovedFocus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="mr-6">
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
                  .catch((reason: unknown) => {
                    const failure = describeFailure(
                      reason,
                      "open the file in Drive",
                    );
                    setError({
                      ...failure,
                      sentence:
                        "Its ticketd record was removed. Find the file in Drive.",
                    });
                  });
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
        {error && <FailureAlert size="compact" failure={error} />}
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

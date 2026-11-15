import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
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

/**
 * Delete a quarantined file permanently (shell AT-15, P7): DialogShell sm
 * with a question title, one sentence, Cancel first and a destructive
 * "Delete permanently". When something still protects the file, the reason
 * shows and there is nothing to confirm. A pending deletion asks to finish.
 */
export function PurgeAttachment({
  file,
  onClose,
  onChanged,
  onPurged,
}: {
  file: Attachment;
  onClose: () => void;
  onChanged: () => void;
  onPurged?: () => void;
}) {
  const [review, setReview] = useState<AttachmentCleanupReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
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
          setError(describeFailure(reason, "check what uses the file"));
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
      onPurged?.();
      onClose();
    } catch (reason) {
      try {
        setReview(await attachments.cleanupReview(file.id));
      } catch {
        // Keep the original failure and allow the same explicit action to retry.
      }
      setError(describeFailure(reason, "delete the file"));
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  const protectedBy =
    review && !review.purge_eligible
      ? review.usage.protections.length
        ? `Still used: ${usageContext(review.usage)}.`
        : review.reason
      : null;
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      title={
        pending
          ? `Finish deleting ${file.display_name}?`
          : `Delete ${file.display_name} permanently?`
      }
      description={
        pending
          ? "Deleting it didn't finish. This can't be undone."
          : "Its name stays in ticketd. The file itself can only come back from an older backup. This can't be undone."
      }
      primaryLabel={
        protectedBy ? null : pending ? "Finish deleting" : "Delete permanently"
      }
      primaryVariant="destructive"
      cancelLabel={protectedBy ? "Close" : "Cancel"}
      blockedReason={
        busy ? "Deleting…" : review ? null : error ? null : "Checking…"
      }
      busy={busy}
      error={
        error && (
          <FailureAlert
            size="compact"
            failure={
              pending
                ? {
                    ...error,
                    sentence:
                      "Deleting is still pending. Finish deleting to complete it.",
                  }
                : error
            }
          />
        )
      }
      onSubmit={() => void purge()}
    >
      {protectedBy && (
        <Alert tone="attention" size="compact">
          <AlertDescription>{protectedBy}</AlertDescription>
        </Alert>
      )}
    </DialogShell>
  );
}

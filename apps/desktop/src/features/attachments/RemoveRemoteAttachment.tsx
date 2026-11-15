import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  attachments,
  type Attachment,
  type AttachmentCleanupReview,
} from "@/lib/api/attachments";
import {
  describeFailure,
  failureText,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { usageContext } from "./usage-context";

/**
 * Remove a Google Drive file's record from ticketd (shell ATT-14): DialogShell
 * sm. The file itself stays in Drive. Once removed the dialog closes and the
 * status line says so, with "Open in Drive"; a lost answer retries the same
 * request.
 */
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
  const statusLine = useStatusLine();
  const [review, setReview] = useState<AttachmentCleanupReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
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
      const result = await attachments.removeRemote(file.id, requestId);
      onChanged();
      onClose();
      onRemovedFocus?.();
      statusLine.show({
        message: `Removed ${file.display_name} from ticketd`,
        action: {
          label: "Open in Drive",
          run: () =>
            attachments
              .openRemovedRemote(result.open_url)
              .catch((reason: unknown) => {
                statusLine.show({
                  tone: "error",
                  message: failureText(reason, "open the file in Drive"),
                });
              }),
        },
      });
    } catch (reason) {
      const failure = describeFailure(reason, "remove the file from ticketd");
      setError({
        ...failure,
        sentence: `${failure.sentence} The file stays in Drive.`,
      });
    } finally {
      setBusy(false);
    }
  }
  const blocked =
    review && !review.remove_eligible
      ? review.usage.protections.length
        ? `Still used: ${usageContext(review.usage)}.`
        : review.usage.legacy_drafts_pending
          ? "Older unsaved drafts may still use it. Review them in every profile first."
          : review.reason
      : null;
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
      title={`Remove ${file.display_name} from ticketd?`}
      description="The file stays in Google Drive, with its sharing unchanged. Only ticketd's record of it goes, including for copies ticketd uploaded."
      primaryLabel="Remove from ticketd"
      initialFocus="cancel"
      blockedReason={
        busy
          ? "Removing…"
          : blocked
            ? "Something still uses it."
            : review || error
              ? null
              : "Checking…"
      }
      busy={busy}
      error={error && <FailureAlert size="compact" failure={error} />}
      onSubmit={() => void remove()}
    >
      {blocked && (
        <Alert tone="attention" size="compact">
          <AlertDescription>{blocked}</AlertDescription>
        </Alert>
      )}
    </DialogShell>
  );
}

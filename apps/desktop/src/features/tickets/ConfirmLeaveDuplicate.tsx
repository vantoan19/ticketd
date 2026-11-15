import type { RefObject } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";

/** Leaving Duplicate removes its canonical relationship in the same core write. */
export function ConfirmLeaveDuplicate({
  canonical,
  status,
  onConfirm,
  onCancel,
  returnFocus,
}: {
  canonical: string;
  status: string | null;
  onConfirm: (status: string) => void;
  onCancel: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  return (
    <DialogShell
      open={status !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      size="sm"
      title={`Change the status to ${status ?? ""}?`}
      description={`This removes the duplicate link to ${canonical}.`}
      primaryLabel="Change status"
      cancelLabel="Keep duplicate"
      blockedReason={null}
      returnFocus={returnFocus}
      onSubmit={() => {
        if (status) onConfirm(status);
      }}
    />
  );
}

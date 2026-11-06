import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
    <Dialog
      open={status !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Remove the duplicate link?</DialogTitle>
          <DialogDescription>
            This removes the duplicate link to {canonical}. Continue?
          </DialogDescription>
        </DialogHeader>
        <div className="settings-actions">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (status) onConfirm(status);
            }}
          >
            Change status
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Keep duplicate
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

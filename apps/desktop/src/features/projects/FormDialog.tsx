import type { FormEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";

/**
 * A small form in a dialog. Closing with Escape or the close button keeps the
 * caller's draft; Cancel discards it. `error` is a failure from saving.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  pending: boolean;
  error: string;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="project-form" onSubmit={submit} noValidate>
          {children}
          {error && <FieldError>{error}</FieldError>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

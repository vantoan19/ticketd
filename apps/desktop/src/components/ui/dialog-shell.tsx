import { useId, type ReactNode, type RefObject } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The centered dialog every flow uses: a 24px title named after the button
 * that opened it, an optional sentence, the form body, and a footer whose
 * primary action stays disabled while `blockedReason` is set. The reason is
 * shown in the footer so a disabled button is never a mystery. Pass
 * `blockedReason={null}` once the form is valid.
 */
export function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  primaryLabel,
  blockedReason,
  onSubmit,
  onCancel,
  returnFocus,
  width = 640,
  footerLeading,
  footerNote,
  primaryHint,
  cancelLabel = "Cancel",
  showClose = true,
  children,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  primaryLabel: string;
  blockedReason: string | null;
  onSubmit: () => void;
  /** Cancel only (not Escape or an outside click): discard the draft. */
  onCancel?: () => void;
  /** Where focus goes on close when the opener no longer exists. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** Dialog width in px (board D: 640; Mark duplicate 713, New project 573). */
  width?: number;
  /** Footer content at the left edge (for example the Create more switch). */
  footerLeading?: ReactNode;
  /** A quiet footer line shown while the primary is available. */
  footerNote?: string;
  /** A shortcut shown inside the primary button. */
  primaryHint?: string;
  /** What dismissing is called where Cancel would mislead, such as Keep open. */
  cancelLabel?: string;
  /** The corner Close button; off where the footer holds the only two ways out. */
  showClose?: boolean;
  children: ReactNode;
  /** A submitted write is still in flight, so dismissing must wait for its result. */
  busy?: boolean;
}) {
  const reasonId = useId();
  const blocked = blockedReason !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden p-0"
        style={{ maxWidth: `min(${width}px, calc(100vw - 32px))`, width }}
        showCloseButton={false}
        {...(returnFocus && { returnFocus })}
      >
        <form
          className="dialog-shell-form relative"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked) onSubmit();
          }}
        >
          <div className="flex items-start gap-3 pt-5 pr-15 pl-6">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogTitle className="text-2xl leading-8 font-semibold tracking-[-0.6px]">
                {title}
              </DialogTitle>
              <DialogDescription className={description ? "" : "sr-only"}>
                {description ?? title}
              </DialogDescription>
            </div>
          </div>
          <div className="dialog-shell-body flex flex-col gap-2 px-6 pt-5 pb-6">
            {children}
          </div>
          <div className="dialog-shell-footer flex h-15 items-center gap-2 bg-(--background) pr-4 pl-6 shadow-[0_-1px_0_0_var(--border)]">
            {footerLeading}
            <p
              id={reasonId}
              className={`flex-1 text-xs text-muted-foreground ${footerLeading ? "text-right" : ""}`}
            >
              {blockedReason ?? footerNote}
            </p>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCancel}
                disabled={busy}
              >
                {cancelLabel}
              </Button>
            </DialogClose>
            <Button
              type="submit"
              size="sm"
              disabled={blocked}
              {...(blocked && { "aria-describedby": reasonId })}
            >
              {primaryLabel}
              {primaryHint && (
                <span className="font-mono text-xs" aria-hidden="true">
                  {primaryHint}
                </span>
              )}
            </Button>
          </div>
          {/* Last in the tab order, drawn in the header's corner. */}
          {showClose && (
            <div className="absolute top-5 right-4">
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  {...(onCancel && { onClick: onCancel })}
                  disabled={busy}
                >
                  <XIcon />
                  <span className="sr-only">Close</span>
                </Button>
              </DialogClose>
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

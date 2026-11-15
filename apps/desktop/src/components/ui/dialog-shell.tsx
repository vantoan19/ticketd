import { useId, useRef, type ReactNode, type RefObject } from "react";
import { XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

/**
 * The one dialog (DESIGN.md section 11, P5). Anchored at max(48px, 12vh) and
 * growing downward, so typing, searching or a result never re-centres it.
 *
 * - Header: a 24/32 title naming the action and its target (a confirm asks a
 *   question: "Move T-FV10 to Trash?"), one optional sentence, the close X.
 * - Body (`children`): 24px inset, scrolls inside; header and footer stay put.
 * - `error`: the failure. The dialog stays open and shows it as a compact
 *   error Alert above the footer; clear it when the person retries.
 * - Footer: a recessed band. `footerLeading` holds one persistent control at
 *   the left (Create more). At the right, the note slot (the blocked reason
 *   while `blockedReason` is set, otherwise `footerNote`: "Created T-FV16 ·
 *   Open", "Nothing changes until you apply."), a ghost Cancel and one 32px
 *   primary with its key hint. Never X plus a "Done": a dialog with nothing
 *   to confirm is the wrong surface.
 *
 * Sizes: `sm` 480 for confirms, `md` 640 for forms and pickers (default),
 * `lg` 920 for review and compare. A multi-step flow keeps one size.
 * Focus starts in the first field; a `destructive` confirm starts on Cancel.
 * It returns to the opener (or `returnFocus`). Never open a dialog from a
 * dialog: replace this one's content instead.
 */
export function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  size = "md",
  primaryLabel,
  primaryVariant = "default",
  cancelLabel = "Cancel",
  blockedReason,
  onSubmit,
  onCancel,
  returnFocus,
  footerLeading,
  footerNote,
  error,
  primaryHint,
  showClose = true,
  initialFocus,
  primaryFirst = false,
  children,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  size?: "sm" | "md" | "lg";
  primaryLabel: string;
  /** `destructive` when confirming stops or removes something. */
  primaryVariant?: "default" | "destructive";
  /** The dismissing button, when Cancel would mislead: Later, Close. */
  cancelLabel?: string;
  /** Why the primary is unavailable ("Add a title to create."); null once valid. */
  blockedReason: string | null;
  onSubmit: () => void;
  /** Cancel only (not Escape or an outside click): discard the draft. */
  onCancel?: () => void;
  /** Where focus goes on close when the opener no longer exists. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** One persistent control at the footer's left edge (the Create more switch). */
  footerLeading?: ReactNode;
  /** The note slot while the primary is available: a count, a result, a consequence. */
  footerNote?: ReactNode;
  /**
   * The failure of the last submit, shown above the footer; the dialog stays
   * open. A string becomes a compact error Alert; pass a FailureAlert for a
   * described failure with Retry and Details.
   */
  error?: ReactNode;
  /** The primary's shortcut, shown as a key inside it ("⌘↵"). */
  primaryHint?: string;
  /** The corner Close button; off where the footer holds the only two ways out. */
  showClose?: boolean;
  /**
   * Where focus starts: the first field (default), the primary, or Cancel
   * (the default for a destructive confirm).
   */
  initialFocus?: "first" | "primary" | "cancel";
  /** Tab reaches the primary button before the dismissing one; both stay where they are drawn. */
  primaryFirst?: boolean;
  children?: ReactNode;
  /** A submitted write is still in flight, so dismissing must wait for its result. */
  busy?: boolean;
}) {
  const reasonId = useId();
  const blocked = blockedReason !== null;
  const primary = useRef<HTMLButtonElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  const focus =
    initialFocus ?? (primaryVariant === "destructive" ? "cancel" : "first");
  const note = blockedReason ?? footerNote;
  const cancel = (
    <DialogClose asChild key="cancel">
      <Button
        ref={dismiss}
        type="button"
        variant="ghost"
        size="sm"
        onClick={onCancel}
        disabled={busy}
      >
        {cancelLabel}
      </Button>
    </DialogClose>
  );
  const submit = (
    <Button
      key="submit"
      ref={primary}
      type="submit"
      variant={primaryVariant}
      size="sm"
      // Ahead of Cancel in the tab order, it is still drawn after it.
      {...(primaryFirst && { className: "order-1" })}
      disabled={blocked}
      {...(blocked && { "aria-describedby": reasonId })}
    >
      {primaryLabel}
      {primaryHint && (
        <Kbd variant="inverted" aria-hidden="true">
          {primaryHint}
        </Kbd>
      )}
    </Button>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        size={size}
        variant="flush"
        showCloseButton={false}
        // Escape that confirms an IME candidate belongs to the field, not the dialog.
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229)
            event.preventDefault();
        }}
        {...(returnFocus && { returnFocus })}
        {...(focus !== "first" && {
          onOpenAutoFocus: (event: Event) => {
            event.preventDefault();
            (focus === "primary" ? primary : dismiss).current?.focus();
          },
        })}
      >
        <form
          className="dialog-shell-form relative min-w-0"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked) onSubmit();
          }}
        >
          <div
            className={`flex flex-col gap-1 pt-6 pr-16 pl-6 ${children ? "" : "pb-5"}`}
          >
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className={description ? "" : "sr-only"}>
              {description ?? title}
            </DialogDescription>
          </div>
          {children && (
            <div className="dialog-shell-body flex flex-col gap-2 px-6 pt-5 pb-6">
              {children}
            </div>
          )}
          {error && (
            <div className="shrink-0 px-6 pb-4">
              {typeof error === "string" ? (
                <Alert tone="error" size="compact">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : (
                error
              )}
            </div>
          )}
          <div className="dialog-shell-footer flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-6 py-3">
            {footerLeading}
            <p id={reasonId} className="dialog-shell-note min-w-40 flex-1">
              {note}
            </p>
            {primaryFirst ? [submit, cancel] : [cancel, submit]}
          </div>
          {/* Last in the tab order, drawn on the title line. */}
          {showClose && (
            <div className="absolute top-6 right-4">
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  {...(onCancel && { onClick: onCancel })}
                  disabled={busy}
                >
                  <XIcon />
                </Button>
              </DialogClose>
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

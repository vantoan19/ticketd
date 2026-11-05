import { useId, type ReactNode, type RefObject } from "react";
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
  returnFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  primaryLabel: string;
  blockedReason: string | null;
  onSubmit: () => void;
  /** Where focus goes on close when the opener no longer exists. */
  returnFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const reasonId = useId();
  const blocked = blockedReason !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-lg"
        {...(returnFocus && { returnFocus })}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked) onSubmit();
          }}
        >
          <div className="flex flex-col gap-1 pt-5 pr-14 pl-6">
            <DialogTitle className="text-2xl leading-8 font-semibold tracking-[-0.6px]">
              {title}
            </DialogTitle>
            <DialogDescription className={description ? "" : "sr-only"}>
              {description ?? title}
            </DialogDescription>
          </div>
          <div className="flex flex-col gap-2 px-6 pt-5 pb-6">{children}</div>
          <div className="flex items-center gap-2 bg-(--recessed) px-6 py-3.5 shadow-[0_-1px_0_0_var(--border)]">
            <p id={reasonId} className="flex-1 text-xs text-muted-foreground">
              {blockedReason}
            </p>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              size="sm"
              disabled={blocked}
              {...(blocked && { "aria-describedby": reasonId })}
            >
              {primaryLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

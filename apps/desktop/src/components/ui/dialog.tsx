import * as React from "react";
import { cn } from "cn";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { OverlayBoundary } from "@/components/ui/overlay-boundary";
import { useFocusReturn } from "@/components/ui/use-focus-return";

// The opener, which focus returns to when the dialog closes.
const DialogInvocation = React.createContext<HTMLElement | null>(null);

function captureInvocation(): HTMLElement | null {
  let element =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const menu = element?.closest("[role=menu]");
  if (menu?.id) {
    element =
      [...document.querySelectorAll<HTMLElement>("[aria-controls]")].find(
        (trigger) => trigger.getAttribute("aria-controls") === menu.id,
      ) ?? element;
  }
  return element;
}

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const [invocation, setInvocation] = React.useState(() => ({
    open: Boolean(props.open),
    origin: props.open ? captureInvocation() : null,
  }));
  if (Boolean(props.open) !== invocation.open) {
    setInvocation({
      open: Boolean(props.open),
      origin: props.open ? captureInvocation() : invocation.origin,
    });
  }
  return (
    <DialogInvocation value={invocation.origin}>
      <DialogPrimitive.Root data-slot="dialog" {...props} />
    </DialogInvocation>
  );
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("ui-overlay fixed inset-0 z-50", className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  overlay = true,
  surface = "default",
  expanded = false,
  variant = "default",
  size,
  returnFocus,
  resolveReturnFocus,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  overlay?: boolean;
  surface?: "default" | "create" | "capture";
  expanded?: boolean;
  showCloseButton?: boolean;
  /**
   * `flush` drops the padding and gap so the content draws its own
   * full-width header, body and footer bands, as the attachment preview does.
   */
  variant?: "default" | "flush";
  /**
   * DESIGN.md section 11: `sm` 480 (confirm), `md` 640 (form, picker), `lg`
   * 920 (review, compare), all anchored at max(48px, 12vh) so they grow
   * downward and never re-centre; `viewer` (the attachment preview only) is
   * min(1120px, 100vw − 64) wide and fits below its 96px top anchor. Use
   * DialogShell for every dialog but the viewer.
   */
  size?: "sm" | "md" | "lg" | "viewer" | "palette";
  /** Where focus goes on close when the opener no longer exists. */
  returnFocus?: React.RefObject<HTMLElement | null>;
  /** The current logical opener when responsive chrome replaced the original node. */
  resolveReturnFocus?: () => HTMLElement | null;
}) {
  const opener = React.useContext(DialogInvocation);
  const focus = useFocusReturn(
    returnFocus,
    {
      ...(onOpenAutoFocus && { onOpenAutoFocus }),
      ...(onCloseAutoFocus && { onCloseAutoFocus }),
    },
    opener,
    resolveReturnFocus,
  );
  return (
    <DialogPortal data-slot="dialog-portal">
      {overlay && <DialogOverlay />}
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-size={size ?? "default"}
        data-surface={surface}
        data-expanded={expanded || undefined}
        className={cn(
          // Position and width come from data-size in styles.css.
          "ui-dialog fixed z-50 grid outline-none",
          variant === "flush" ? "gap-0 overflow-hidden p-0" : "gap-4 p-6",
          className,
        )}
        {...props}
        {...focus}
      >
        {/* Overlays inside a dialog are bounded by the window, not the pane below. */}
        <OverlayBoundary element={null}>{children}</OverlayBoundary>
        {showCloseButton && (
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-3 top-3"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({
  className,
  children,
  showCloseButton = false,
  ...props
}: React.ComponentProps<"div"> & { showCloseButton?: boolean }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "relative flex flex-col gap-2 text-center sm:text-left",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ui-dialog-header-close absolute -right-3 -top-3"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("ui-section-title", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};

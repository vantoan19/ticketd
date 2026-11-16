import * as React from "react";
import { useClosingOverlayRef } from "@/components/ui/use-closing-overlay-ref";
import { cn } from "cn";
import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";

import { useFocusReturn } from "@/components/ui/use-focus-return";

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn("ui-overlay fixed inset-0 z-50", className)}
      {...props}
    />
  );
}

function SheetContent({
  className,
  ref,
  children,
  side = "right",
  size = "default",
  showCloseButton = true,
  returnFocus,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left";
  /**
   * `nav`: a navigation sheet (DESIGN section 5), at most 280px or the window
   * less 32px, with no inset: the nav inside sets its own.
   */
  size?: "default" | "nav";
  showCloseButton?: boolean;
  /** Where focus goes on close when the opener no longer exists. */
  returnFocus?: React.RefObject<HTMLElement | null>;
}) {
  const contentRef = useClosingOverlayRef(ref);
  const focus = useFocusReturn(returnFocus, {
    ...(onOpenAutoFocus && { onOpenAutoFocus }),
    ...(onCloseAutoFocus && { onCloseAutoFocus }),
  });
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={contentRef}
        data-slot="sheet-content"
        data-side={side}
        data-size={size}
        className={cn(
          "ui-sheet fixed z-50 flex flex-col",
          size === "default" && "gap-4",
          side === "right" && "inset-y-0 right-0 h-full",
          side === "left" && "inset-y-0 left-0 h-full",
          (side === "right" || side === "left") &&
            size === "default" &&
            "w-3/4 sm:max-w-sm",
          side === "top" && "inset-x-0 top-0 h-auto",
          side === "bottom" && "inset-x-0 bottom-0 h-auto",
          className,
        )}
        {...props}
        {...focus}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-(--ring) disabled:pointer-events-none data-[state=open]:bg-secondary">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};

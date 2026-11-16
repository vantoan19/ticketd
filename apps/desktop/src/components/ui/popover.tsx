import * as React from "react";
import { preserveNewerFocus } from "@/components/ui/use-focus-return";
import { useClosingOverlayRef } from "@/components/ui/use-closing-overlay-ref";
import { cn } from "cn";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useOverlayBoundary } from "@/components/ui/overlay-boundary";

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/**
 * A popover holds a small form or a ChoiceList (P3), never a column of
 * buttons; when its trigger is icon-only it carries a title. It opens below
 * the trigger inside the nearest OverlayBoundary with 16px clearance.
 * `variant="list"` holds a ChoiceList or picker: 4px padding, at least as
 * wide as the trigger and 280px. `variant="bar"` holds a row of icon buttons
 * floating over content (the editor's selection bubble): 4px padding, as wide
 * as its buttons. `compact-list` uses 260px for caret block choices.
 */
function PopoverContent({
  className,
  ref,
  align = "center",
  sideOffset = 4,
  collisionPadding = 16,
  collisionBoundary,
  onCloseAutoFocus,
  variant = "form",
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  variant?:
    "form" | "workspace" | "list" | "compact-list" | "constrained-list" | "bar";
}) {
  const contentRef = useClosingOverlayRef(ref);
  const boundary = useOverlayBoundary();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={contentRef}
        data-slot="popover-content"
        data-variant={variant}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        collisionBoundary={collisionBoundary ?? boundary}
        className={cn(
          "ui-popover z-50 origin-(--radix-popover-content-transform-origin) outline-hidden",
          (variant === "form" || variant === "workspace") && "w-72 p-4",
          className,
        )}
        {...props}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (!event.defaultPrevented) preserveNewerFocus(event);
        }}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  );
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
};

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";

const buttonVariants = cva(
  "ui-button inline-flex shrink-0 items-center data-busy:pointer-events-none justify-center gap-2 whitespace-nowrap disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: "ui-button-primary",
        destructive: "ui-button-destructive",
        outline: "ui-button-outline",
        property: "ui-button-property",
        secondary: "ui-button-secondary",
        ghost: "ui-button-ghost",
        attention: "ui-button-ghost ui-button-attention",
        link: "ui-button-link",
        jump: "ui-button-jump",
        card: "ui-button-card",
      },
      size: {
        default: "h-10 px-4",
        xs: "h-8 px-2",
        compact: "h-7 gap-1.5 px-2.5",
        "compact-responsive": "ui-button-compact-responsive h-7 gap-1.5 px-2.5",
        sm: "h-8 px-3",
        lg: "h-12 px-6",
        icon: "size-10",
        "icon-xs": "size-8",
        "icon-card": "size-6 [&_svg]:size-3.5",
        "icon-compact": "size-7",
        card: "h-auto p-0",
        "icon-sm": "size-8",
        "icon-row-action": "ui-button-icon-row-action size-6",
        "icon-lg": "size-12",
        // An action link inside a sentence or caption: no padding, the text's height.
        inline: "h-auto p-0 align-baseline",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  readOnly = false,
  busy = false,
  onClick,
  ref,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Shows a disabled control at full strength, for content that is viewable but locked. */
    readOnly?: boolean;
    /**
     * An action is under way. The button looks disabled and does nothing, but
     * stays focusable (so focus is not dropped on the page) and keeps the width
     * it had, so a shorter label ("Installing…") does not move its neighbours.
     */
    busy?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";
  const own = React.useRef<HTMLElement | null>(null);
  const idleWidth = React.useRef(0);
  React.useLayoutEffect(() => {
    const node = own.current;
    if (!node) return;
    if (busy) {
      if (idleWidth.current) node.style.minWidth = `${idleWidth.current}px`;
    } else {
      node.style.minWidth = "";
      idleWidth.current = node.getBoundingClientRect().width;
    }
  });
  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      own.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  return (
    <Comp
      ref={setRef}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-readonly={readOnly || undefined}
      data-busy={busy || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...(busy && { "aria-disabled": true, "aria-busy": true })}
      {...((onClick || busy) && {
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          // Also stops a busy submit button from submitting its form again.
          if (busy) event.preventDefault();
          else onClick?.(event);
        },
      })}
      {...props}
    />
  );
}

export { Button };

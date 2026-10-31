import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";

const buttonVariants = cva(
  "ui-button inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: "ui-button-primary",
        destructive: "ui-button-destructive",
        outline: "ui-button-outline",
        secondary: "ui-button-secondary",
        ghost: "ui-button-ghost",
        link: "ui-button-link",
      },
      size: {
        default: "h-10 px-4",
        xs: "h-8 px-2",
        sm: "h-8 px-3",
        lg: "h-12 px-6",
        icon: "size-10",
        "icon-xs": "size-8",
        "icon-sm": "size-8",
        "icon-lg": "size-12",
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
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Shows a disabled control at full strength, for content that is viewable but locked. */
    readOnly?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-readonly={readOnly || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };

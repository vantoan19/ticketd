import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";

const badgeVariants = cva("ui-badge", {
  variants: {
    variant: {
      tag: "",
      source: "ui-badge-source",
      doc: "ui-badge-doc",
    },
    size: {
      default: "",
      sm: "ui-badge-sm",
    },
    // `raised` sits on a recessed control, such as the property rail’s tag picker.
    tone: {
      default: "",
      raised: "ui-badge-raised",
    },
  },
  defaultVariants: {
    variant: "tag",
    size: "default",
    tone: "default",
  },
});

/**
 * The one look for a tag-like label: a ticket or Document tag (`tag`), an
 * external source reference such as #98 (`source`), or a Document chip
 * (`doc`, 28px). `sm` fits inside ticket rows. A badge names something;
 * `asChild` lends the look to the link or button that opens it.
 */
function Badge({
  className,
  variant = "tag",
  size = "default",
  tone = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant, size, tone }), className)}
      {...props}
    />
  );
}

export { Badge };

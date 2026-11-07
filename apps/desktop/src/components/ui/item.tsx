import * as React from "react";
import { cn } from "cn";
import { Slot } from "radix-ui";

/**
 * One compact row for a small list inside a section: a leading icon, a
 * `Reference`, a truncating title, then trailing meta or actions. At least
 * 36px tall with a `radius` hover fill. Feature stylesheets place the
 * children, usually on a grid, by targeting `[data-slot="item"]`. `asChild`
 * lends the look to the `li` that holds the row.
 */
function Item({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";

  return (
    <Comp data-slot="item" className={cn("ui-item", className)} {...props} />
  );
}

export { Item };

import * as React from "react";
import { cn } from "cn";
import { Slot } from "radix-ui";
import "./ledger.css";

/**
 * One compact row for a small list inside a section: a leading icon, a
 * `Reference`, a truncating title, then trailing meta or actions. At least
 * 36px tall with a `radius` hover fill. Feature stylesheets place the
 * children, usually on a grid, by targeting `[data-slot="item"]`. `asChild`
 * lends the look to the `li` that holds the row. `ledger` and `ledger-group`
 * supply the quieter full-width ticket-list surface; feature CSS owns the lanes.
 */
function Item({
  className,
  asChild = false,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  asChild?: boolean;
  variant?: "default" | "ledger" | "ledger-group" | "navigator";
}) {
  const Comp = asChild ? Slot.Root : "div";

  return (
    <Comp
      data-slot="item"
      data-variant={variant}
      className={cn(
        "ui-item",
        variant !== "default" && `ui-item-${variant}`,
        className,
      )}
      {...props}
    />
  );
}

export { Item };

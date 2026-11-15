import * as React from "react";
import { cn } from "cn";

/**
 * One key of a shortcut. `inverted` sits on a dark fill, the tooltip chip or a
 * primary button: no background, the text colour of its parent and a faint
 * ring drawn from it.
 */
function Kbd({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"kbd"> & { variant?: "default" | "inverted" }) {
  return (
    <kbd
      data-slot="kbd"
      data-variant={variant}
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-sm px-1 font-mono text-xs leading-5",
        variant === "inverted"
          ? "min-w-4 leading-4 text-current ring-1 ring-current/30 ring-inset"
          : "bg-(--surface) text-secondary-foreground shadow-(--shadow-border-base)",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };

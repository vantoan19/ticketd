import * as React from "react";
import { cn } from "cn";
import "./patterns.css";

/**
 * A text field. `variant="inline"` edits text in place (a Plan's name in its
 * header, a purpose in a caption line): it takes the surrounding type and a
 * 6px inset so the text stays where it was read; size its height with
 * `h-8` or `h-6` and its width with a wrapper.
 */
function Input({
  className,
  type,
  variant = "default",
  ...props
}: React.ComponentProps<"input"> & {
  variant?: "default" | "inline" | "title" | "document-title" | "capture-title";
}) {
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant === "default" ? undefined : variant}
      className={cn(
        "ui-input h-10 w-full min-w-0 px-3 py-2 selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-8 file:border-0 file:bg-transparent file:text-sm file:font-normal file:text-foreground disabled:pointer-events-none",
        variant === "inline" && "ui-input-inline",
        variant === "title" && "ui-input-title",
        className,
      )}
      {...props}
    />
  );
}

export { Input };

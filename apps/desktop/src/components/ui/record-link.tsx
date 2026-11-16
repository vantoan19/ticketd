import * as React from "react";
import { cn } from "cn";
import { Reference } from "@/components/ui/reference";
import "./patterns.css";

/**
 * A reference or record in running text that opens it: foreground text with
 * a 1px `--interactive` underline at a 3px offset, the link colour on hover
 * (P15). It inherits the size of the text around it. `reference` is shown in
 * the mono Reference face before any `children` (a title); a reference never
 * shows brackets. `gone` is the plain form where nothing opens (deleted, not
 * found): no underline, not a button.
 */
function RecordLink({
  reference,
  gone = false,
  variant = "prose",
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  reference?: string;
  gone?: boolean;
  /** Compact structured record row with a muted reference and truncated title. */
  variant?: "prose" | "row";
}) {
  const content = (
    <>
      {reference && <Reference>{reference}</Reference>}
      {reference && children ? " " : null}
      {variant === "row" ? (
        <span data-slot="record-title">{children}</span>
      ) : (
        children
      )}
    </>
  );
  if (gone)
    return (
      <span
        data-slot="record-link"
        data-variant={variant}
        data-gone=""
        className={cn("ui-record-link", className)}
      >
        {content}
      </span>
    );
  return (
    <button
      type="button"
      data-slot="record-link"
      data-variant={variant}
      className={cn("ui-record-link", className)}
      {...props}
    >
      {content}
    </button>
  );
}

export { RecordLink };

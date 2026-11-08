import * as React from "react";
import { cn } from "cn";

/** A ticket, source or commit reference (T-1, #98, 4f2a9c1) in Geist Mono. */
function Reference({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="reference"
      className={cn("ui-reference", className)}
      {...props}
    />
  );
}

export { Reference };

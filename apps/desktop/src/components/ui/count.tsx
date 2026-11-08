import * as React from "react";
import { cn } from "cn";

/** A count beside the label it counts, in caption-size tabular numbers. */
function Count({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="count" className={cn("ui-count", className)} {...props} />
  );
}

export { Count };

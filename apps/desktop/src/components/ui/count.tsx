import * as React from "react";
import { cn } from "cn";
import { CrossfadeText } from "@/components/ui/motion";

/**
 * A count beside the label it counts, in caption-size tabular numbers. A
 * number or word that changes crossfades in place (DESIGN.md section 12); every
 * count in the app gets that from here.
 */
function Count({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span data-slot="count" className={cn("ui-count", className)} {...props}>
      {typeof children === "number" || typeof children === "string" ? (
        <CrossfadeText>{String(children)}</CrossfadeText>
      ) : (
        children
      )}
    </span>
  );
}

export { Count };

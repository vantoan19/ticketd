import type { ReactNode } from "react";
import { cn } from "cn";
import "./patterns.css";

/**
 * A 40px recessed tile holding a 20px muted icon: the one recipe for page
 * headers, settings rows and empty states. In a list every row has one or
 * none does. Decorative: the words beside it name the thing.
 */
export function IconTile({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="icon-tile"
      className={cn("ui-icon-tile", className)}
    >
      {children}
    </span>
  );
}

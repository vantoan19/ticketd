import type { ReactNode } from "react";
import { cn } from "cn";
import { StatusDot, type StatusDotTone } from "./status-dot";

/**
 * A `StatusDot` and the word that says what it means: the one way to show a
 * status. `size` "ui" is body text (14/20); "caption" is 12/16, for use
 * beside other caption text.
 */
export function StatusLabel({
  tone,
  size = "ui",
  className,
  children,
}: {
  tone: StatusDotTone;
  size?: "ui" | "caption";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-slot="status-label"
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-foreground",
        size === "caption" ? "text-xs leading-4" : "text-sm leading-5",
        className,
      )}
    >
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

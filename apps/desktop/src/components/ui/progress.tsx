import * as React from "react";
import { cn } from "cn";
import { Progress as ProgressPrimitive } from "radix-ui";

/**
 * A 64px progress bar. Put its words beside it ("1 of 2 done"), since the
 * bar alone does not say what is counted, and name it with `aria-label`.
 */
function Progress({
  className,
  value,
  max = 100,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const share = value == null || max <= 0 ? 0 : Math.min(value / max, 1);

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      max={max}
      className={cn("ui-progress", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="ui-progress-indicator"
        style={{ width: `${share * 100}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

/** A labelled key for a segment in a multi-status progress bar. */
function ProgressKey({
  segment,
  children,
}: {
  segment: "done" | "review" | "progress" | "todo";
  children: React.ReactNode;
}) {
  return (
    <span className="ui-progress-key">
      <i data-segment={segment} aria-hidden="true" />
      {children}
    </span>
  );
}
export { Progress, ProgressKey };

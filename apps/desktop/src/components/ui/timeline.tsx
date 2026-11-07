import * as React from "react";
import { cn } from "cn";
import type { LucideIcon } from "lucide-react";

/**
 * The list that joins updates and recorded changes with one 2px line, as on a
 * GitHub issue. Its children are `li`s: an `EventRow`, or a plain `li` that
 * holds a `Card`. The line shows between items and runs behind badges and cards;
 * `plain` leaves it out (only Activity is connected, DESIGN.md section 8).
 */
function Timeline({
  className,
  plain = false,
  ...props
}: React.ComponentProps<"ol"> & { plain?: boolean }) {
  return (
    <ol
      data-slot="timeline"
      data-plain={plain ? "" : undefined}
      className={cn("ui-timeline", className)}
      {...props}
    />
  );
}

/**
 * One recorded change on a `Timeline`: a 28px badge carrying the change's icon,
 * the sentence as children, then who and when as `meta` in the caption size.
 */
function EventRow({
  icon: Icon,
  meta,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"li">, "children"> & {
  icon: LucideIcon;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li
      data-slot="event-row"
      className={cn("ui-event-row", className)}
      {...props}
    >
      <span data-slot="event-row-badge" className="ui-event-row-badge">
        <Icon aria-hidden="true" />
      </span>
      <span className="ui-event-row-text">
        {children}
        {meta && <span className="ui-event-row-meta">{meta}</span>}
      </span>
    </li>
  );
}

export { Timeline, EventRow };

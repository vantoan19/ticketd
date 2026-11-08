import * as React from "react";
import { cn } from "cn";
import type { LucideIcon } from "lucide-react";

/**
 * The list that joins comments, updates and recorded changes with one 2px
 * line, as on a GitHub issue. Its children are `CommentRow`s and `EventRow`s;
 * the line runs behind their badges.
 */
function Timeline({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="timeline"
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

/**
 * A comment or update on a `Timeline`, with no card: the badge sits on the
 * line, `header` names who and when, as an event row does, with `actions` at the
 * end, and the body (children) reads beneath it. `label` names the article.
 */
function CommentRow({
  icon: Icon,
  header,
  actions,
  label,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"li">, "children"> & {
  icon: LucideIcon;
  header: React.ReactNode;
  actions?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li
      data-slot="comment-row"
      className={cn("ui-comment-row", className)}
      {...props}
    >
      <span data-slot="event-row-badge" className="ui-event-row-badge">
        <Icon aria-hidden="true" />
      </span>
      <article aria-label={label} className="ui-comment-row-main">
        <div className="ui-comment-row-header">
          <span className="ui-comment-row-meta">{header}</span>
          {actions && <span className="ui-comment-row-actions">{actions}</span>}
        </div>
        {children}
      </article>
    </li>
  );
}

export { Timeline, EventRow, CommentRow };

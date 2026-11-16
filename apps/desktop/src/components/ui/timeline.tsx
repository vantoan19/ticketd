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
 * `time`, when given, sits in a right-aligned trailing column that never
 * wraps, so a long sentence never leaves its time on a line of its own.
 */
function EventRow({
  icon: Icon,
  meta,
  time,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"li">, "children"> & {
  icon: LucideIcon;
  meta?: React.ReactNode;
  time?: React.ReactNode;
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
      {time && <span className="ui-event-row-time">{time}</span>}
    </li>
  );
}

/** Consecutive recorded changes, folded without crossing an authored update. */
function EventGroup({
  icon: Icon,
  summary,
  time,
  children,
}: {
  icon: LucideIcon;
  summary: string;
  time: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <li data-slot="event-group" className="ui-event-group">
      <div className="ui-event-group-header">
        <button
          type="button"
          className="ui-event-group-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="ui-event-row-badge">
            <Icon aria-hidden="true" />
          </span>
          <span className="ui-event-group-summary">{summary}</span>
        </button>
        <span className="ui-event-row-time">{time}</span>
      </div>
      <ol id={id} className="ui-event-group-details" hidden={!open}>
        {open && children}
      </ol>
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
  mark,
  header,
  actions,
  label,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"li">, "children"> & {
  icon: LucideIcon;
  mark?: React.ReactNode;
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
        {mark ?? <Icon aria-hidden="true" />}
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

export { Timeline, EventRow, EventGroup, CommentRow };

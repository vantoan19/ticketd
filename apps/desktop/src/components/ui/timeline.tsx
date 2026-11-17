import * as React from "react";
import { m } from "motion/react";
import { cn } from "cn";
import type { LucideIcon } from "lucide-react";
import { Expand, Presence } from "@/components/ui/motion";
import { arrival, departure, glide } from "@/components/ui/row-motion";

type ItemProps = Omit<React.ComponentProps<typeof m.li>, "children">;

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
 * An `EventGroup` sets `index` on its rows, so they fade up one after another.
 */
function EventRow({
  icon: Icon,
  meta,
  time,
  index,
  className,
  children,
  ...props
}: ItemProps & {
  icon: LucideIcon;
  meta?: React.ReactNode;
  time?: React.ReactNode;
  index?: number;
  children: React.ReactNode;
}) {
  return (
    <m.li
      data-slot="event-row"
      className={cn("ui-event-row", className)}
      {...(index !== undefined && { ...arrival(index), ...departure() })}
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
    </m.li>
  );
}

/**
 * Consecutive recorded changes, folded without crossing an authored update.
 * Opening grows the height on the smooth spring while the rows fade up one
 * after another and what follows glides down; closing fades the rows out as
 * the height closes.
 */
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
    <m.li data-slot="event-group" className="ui-event-group" {...glide()}>
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
      <Expand open={open}>
        <ol id={id} className="ui-event-group-details">
          <Presence>
            {open &&
              React.Children.map(children, (child, index) =>
                React.isValidElement<{ index?: number }>(child)
                  ? React.cloneElement(child, { index })
                  : child,
              )}
          </Presence>
        </ol>
      </Expand>
    </m.li>
  );
}

/**
 * A comment or update on a `Timeline`, with no card: the badge sits on the
 * line, `header` names who and when, as an event row does, with `actions` at the
 * end, and the body (children) reads beneath it. `label` names the article.
 * An `arriving` row opens its space and fades up from a soft blur while the
 * rows after it glide down.
 */
function CommentRow({
  icon: Icon,
  mark,
  header,
  actions,
  label,
  arriving = false,
  className,
  children,
  ...props
}: ItemProps & {
  icon: LucideIcon;
  mark?: React.ReactNode;
  header: React.ReactNode;
  actions?: React.ReactNode;
  label: string;
  arriving?: boolean;
  children: React.ReactNode;
}) {
  return (
    <m.li
      data-slot="comment-row"
      className={cn("ui-comment-row", className)}
      {...glide()}
      {...(arriving && arrival())}
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
    </m.li>
  );
}

export { Timeline, EventRow, EventGroup, CommentRow };

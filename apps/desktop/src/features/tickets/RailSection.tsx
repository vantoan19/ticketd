import { use, useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "cn";
import { Tooltip } from "@/components/ui/tooltip";
import { SectionHeader } from "@/components/ui/section-header";
import { RailPlacement } from "./rail-placement";

/**
 * One labelled section of the property rail (P13): a 12px muted label with
 * its `actions` (an icon "+") at the label's end, then its rows. Rows and the
 * label share one left edge; 20px separates sections. In a narrow pane's
 * reading column the same section renders through SectionHeader.
 */
export function RailSection({
  label,
  actions,
  children,
  className,
  count,
  summary,
}: {
  label: string;
  /** Icon buttons at the end of the label row, such as Attach. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  count?: ReactNode;
  summary?: ReactNode;
}) {
  const id = useId();
  const placement = use(RailPlacement);
  if (placement === "column")
    return (
      <section
        className={cn("rail-section", "rail-section-column", className)}
        aria-labelledby={id}
      >
        <SectionHeader
          title={label}
          titleId={id}
          actions={actions}
          count={count}
        >
          {summary}
        </SectionHeader>
        {children}
      </section>
    );
  return (
    <section className={cn("rail-section", className)} aria-labelledby={id}>
      <div className="rail-label-row">
        <h3 id={id} className="rail-label">
          {label}
        </h3>
        {actions && <span className="rail-label-actions">{actions}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * A property value or action in the rail (P12 RailRow): 32px and the full
 * rail width, outdented 12px so its 16px icon and text start on the label's
 * edge. The value is foreground, or muted when empty ("No project", or an
 * action such as "Add relationship"). One hover fill, no chevrons. The 16px
 * `trailing` slot holds a check, a count or "Saving…", so nothing moves. In
 * the folded property strip the same row is a ghost chip. `readOnly` shows a
 * value that cannot change (Trash) at full strength, without hover.
 */
export function RailRow({
  icon,
  muted = false,
  readOnly = false,
  trailing,
  children,
  className,
  title,
  ...props
}: ComponentProps<"button"> & {
  icon?: ReactNode;
  muted?: boolean;
  readOnly?: boolean;
  trailing?: ReactNode;
}) {
  const button = (
    <button
      type="button"
      className={cn("rail-row", className)}
      data-muted={muted || undefined}
      data-readonly={readOnly || undefined}
      {...props}
    >
      {icon}
      <span className="rail-row-value">{children}</span>
      {trailing && <span className="rail-row-trailing">{trailing}</span>}
    </button>
  );
  return title ? <Tooltip content={title}>{button}</Tooltip> : button;
}

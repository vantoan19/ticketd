import type { ReactNode } from "react";
import { cn } from "cn";
import { IconTile } from "@/components/ui/icon-tile";
import "./patterns.css";

/**
 * The one empty-state pattern (DESIGN.md section 12). Take the words from
 * `lib/empty-copy.ts`.
 *
 * - `block` (a view or list region has nothing): IconTile, title, one
 *   sentence, sm actions. Top-anchored 48px below the region's last fixed
 *   row, centred in its column, never boxed; `anchor="center"` centres it in a
 *   canvas (graph, dependencies). A no-match view uses the `SearchX` icon.
 * - `inline` (inside a section): one muted line, its action at the end;
 *   `plain` drops the recessed band where the section already has a heading.
 * - `hint` (nothing selected): one muted line centred on both axes and an
 *   optional key footnote; no icon or action.
 *
 * Action rule: a primary only when it is the only way to fill the view and no
 * other primary is visible; otherwise outline sm; none when the header holds
 * the same action. Chrome rule: hide or disable what acts on nothing (Search,
 * Filters and Display over zero items, paging, count footers).
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  footnote,
  size = "block",
  anchor = "top",
  plain = false,
  className,
  role,
}: {
  icon?: ReactNode;
  title?: string;
  description?: string;
  action?: ReactNode;
  /** Optional small hint under the action. */
  footnote?: ReactNode;
  size?: "block" | "inline" | "hint";
  /** Block only: `center` for a canvas, where there is no row to hang from. */
  anchor?: "top" | "center";
  /** Inline only: no recessed surface, just the line and its action. */
  plain?: boolean;
  className?: string;
  role?: "alert" | "status";
}) {
  if (size === "hint")
    return (
      <div
        data-slot="empty-state"
        data-size="hint"
        role={role}
        className={cn(
          "flex flex-col items-center justify-center gap-2 text-center text-sm text-pretty text-muted-foreground",
          className,
        )}
      >
        <p>{title}</p>
        {footnote && (
          <p className="flex items-center gap-1.5 text-xs [&_svg]:size-3">
            {footnote}
          </p>
        )}
      </div>
    );
  if (size === "inline")
    return (
      <div
        data-slot="empty-state"
        data-size="inline"
        data-plain={plain || undefined}
        role={role}
        className={cn(
          "flex items-center gap-3 text-sm text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0",
          !plain &&
            "rounded-lg bg-(--recessed) px-3.5 py-3 shadow-(--shadow-border-base)",
          className,
        )}
      >
        {icon && <span aria-hidden="true">{icon}</span>}
        <p className="flex-1 text-pretty">
          {title && (
            <span className="font-medium text-foreground">{title} </span>
          )}
          {description}
        </p>
        {action}
      </div>
    );
  return (
    <div
      data-slot="empty-state"
      data-size="block"
      data-anchor={anchor}
      role={role}
      className={cn("ui-empty", className)}
    >
      {icon && <IconTile>{icon}</IconTile>}
      {title && <p className="ui-empty-title">{title}</p>}
      {description && <p className="ui-empty-sentence">{description}</p>}
      {action && <div className="ui-empty-actions">{action}</div>}
      {footnote && <p className="ui-empty-footnote">{footnote}</p>}
    </div>
  );
}

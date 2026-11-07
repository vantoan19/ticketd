import type { ReactNode } from "react";
import { cn } from "cn";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * The one empty-state pattern: icon, short title, one sentence on what will
 * appear, and the one action that fills it (`action`, usually a secondary
 * Button; several sit side by side). Sizes: `block` for an empty view,
 * `inline` for a row inside a card or section (the action sits at the end),
 * `hint` for a quiet pane: one line and an optional footnote, no icon or
 * action. Icon, title and description are optional where a size does not
 * need them.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  footnote,
  size = "block",
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
          "flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground",
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
        role={role}
        className={cn(
          "flex items-center gap-3 rounded-lg bg-(--recessed) px-3.5 py-3 text-sm text-muted-foreground shadow-(--shadow-border-base) [&_svg]:size-4 [&_svg]:shrink-0",
          className,
        )}
      >
        {icon && <span aria-hidden="true">{icon}</span>}
        <p className="flex-1">
          {title && (
            <span className="font-medium text-foreground">{title} </span>
          )}
          {description}
        </p>
        {action}
      </div>
    );
  return (
    <Empty
      data-slot="empty-state"
      data-size="block"
      role={role}
      className={cn("gap-3 p-6 text-wrap md:p-6", className)}
    >
      <EmptyHeader className="max-w-95 gap-1">
        {icon && (
          <EmptyMedia
            variant="icon"
            className="rounded-lg text-secondary-foreground [&_svg:not([class*='size-'])]:size-5 [&_svg]:stroke-[1.75]"
          >
            <span aria-hidden="true" className="contents">
              {icon}
            </span>
          </EmptyMedia>
        )}
        {title && (
          <EmptyTitle className="text-sm font-medium tracking-normal">
            {title}
          </EmptyTitle>
        )}
        {description && (
          <EmptyDescription className="text-wrap">
            {description}
          </EmptyDescription>
        )}
      </EmptyHeader>
      {action && (
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">{action}</div>
        </EmptyContent>
      )}
      {footnote && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3">
          {footnote}
        </p>
      )}
    </Empty>
  );
}

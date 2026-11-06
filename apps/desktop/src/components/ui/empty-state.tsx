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
 * Button). `inline` is the compact variant for inside a card or section;
 * there the action sits at the end of the row.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  footnote,
  inline = false,
  className,
  role,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  /** Optional small hint under the action. */
  footnote?: ReactNode;
  inline?: boolean;
  className?: string;
  role?: "alert" | "status";
}) {
  if (inline)
    return (
      <div
        data-slot="empty-state"
        data-inline="true"
        role={role}
        className={cn(
          "flex items-center gap-3 rounded-lg bg-(--recessed) px-3.5 py-3 text-sm text-muted-foreground shadow-(--shadow-border-base) [&_svg]:size-4 [&_svg]:shrink-0",
          className,
        )}
      >
        <span aria-hidden="true">{icon}</span>
        <p className="flex-1">
          <span className="font-medium text-foreground">{title}</span>{" "}
          {description}
        </p>
        {action}
      </div>
    );
  return (
    <Empty
      data-slot="empty-state"
      role={role}
      className={cn("gap-3 p-6 text-wrap md:p-6", className)}
    >
      <EmptyHeader className="max-w-[380px] gap-1">
        <EmptyMedia variant="icon" className="mb-0 rounded-lg">
          <span aria-hidden="true" className="contents">
            {icon}
          </span>
        </EmptyMedia>
        <EmptyTitle className="text-sm font-medium tracking-normal">
          {title}
        </EmptyTitle>
        <EmptyDescription className="text-wrap">{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
      {footnote && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3">
          {footnote}
        </p>
      )}
    </Empty>
  );
}

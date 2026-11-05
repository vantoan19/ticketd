import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * The 48px header every list view shares (styled by `.list-header`): a small
 * title, optional controls after it (filters, segmented control), and
 * `actions` pushed to the end.
 */
export function ListHeader({
  title,
  children,
  actions,
  className,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header data-slot="list-header" className={cn("list-header", className)}>
      <h1>{title}</h1>
      {children}
      <span className="flex-1" />
      {actions}
    </header>
  );
}

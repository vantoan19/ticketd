import type { ReactNode } from "react";
import { cn } from "cn";
import { Count } from "@/components/ui/count";

/**
 * The heading row every section shares: a title in the heading role (`level`
 * picks h1 to h3, default h3), an optional `count`, optional controls after
 * it (`children`: a segmented control, progress, a caption), and `actions`
 * pushed to the end. `divided` draws a hairline above it to set sections
 * apart. It owns no data.
 */
export function SectionHeader({
  title,
  titleId,
  level = 3,
  count,
  children,
  actions,
  divided = false,
  bar = false,
  className,
}: {
  title: ReactNode;
  titleId?: string;
  level?: 1 | 2 | 3;
  count?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  divided?: boolean;
  /** A fixed 44px band that opens a panel, with a hairline under it. */
  bar?: boolean;
  className?: string;
}) {
  const Heading = `h${level}` as const;
  return (
    <div
      data-slot="section-header"
      data-divided={divided ? "" : undefined}
      data-bar={bar ? "" : undefined}
      className={cn("ui-section-header", className)}
    >
      <Heading id={titleId}>{title}</Heading>
      {count != null && <Count>{count}</Count>}
      {children}
      {actions && <span data-slot="section-header-actions">{actions}</span>}
    </div>
  );
}

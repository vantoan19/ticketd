import type { ReactNode } from "react";
import { cn } from "cn";
import { Count } from "@/components/ui/count";

/**
 * The heading row every section shares: a title in the heading role (`level`
 * picks h1 to h3, default h3), an optional `count`, optional controls after
 * it (`children`: a segmented control, progress, a caption), and `actions`
 * pushed to the end. `caption` is a muted line of its own under the row. Space,
 * not a hairline, sets sections apart (DESIGN.md section 8).
 * It owns no data.
 */
export function SectionHeader({
  title,
  titleId,
  level = 3,
  count,
  children,
  actions,
  caption,
  bar = false,
  className,
}: {
  title: ReactNode;
  titleId?: string;
  level?: 1 | 2 | 3;
  count?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** A muted note on its own line under the row, at every width. */
  caption?: ReactNode;
  /** A fixed 44px band that opens a panel, with a hairline under it. */
  bar?: boolean;
  className?: string;
}) {
  const Heading = `h${level}` as const;
  return (
    <div
      data-slot="section-header"
      data-bar={bar ? "" : undefined}
      className={cn("ui-section-header", className)}
    >
      {/* The count is part of the heading, so the name stays “Evidence 2”. */}
      <Heading id={titleId}>
        {title}
        {count != null && (
          <>
            {" "}
            <Count>{count}</Count>
          </>
        )}
      </Heading>
      {children}
      {actions && <span data-slot="section-header-actions">{actions}</span>}
      {caption && <small data-slot="section-header-caption">{caption}</small>}
    </div>
  );
}

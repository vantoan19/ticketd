import type { ReactNode, Ref } from "react";
import { cn } from "cn";
import { ShellLeading, ShellNoticeSlot } from "@/components/ui/list-header";
import "./patterns.css";

/**
 * The shell of a management page (Plans, Archived Plans, Projects,
 * Attachments): one column at most 960px wide, left-aligned on the page
 * gutter (32px, 16px narrow), scrolling on its own. Name it with
 * `aria-labelledby` pointing at its PageHeader's `titleId`.
 */
export function ManagementPage({
  className,
  layout = "default",
  children,
  "aria-labelledby": labelledBy,
  "aria-label": label,
  ref,
}: {
  ref?: Ref<HTMLElement>;
  className?: string;
  layout?: "default" | "centered" | "guide";
  children: ReactNode;
  "aria-labelledby"?: string;
  "aria-label"?: string;
}) {
  return (
    <section
      ref={ref}
      data-slot="management-page"
      aria-labelledby={labelledBy}
      aria-label={label}
      className={cn(
        "ui-management-page",
        layout === "centered" && "ui-management-page-centered",
        layout === "guide" && "ui-management-page-guide",
        className,
      )}
    >
      {children}
    </section>
  );
}

/**
 * A management page's header: the title (24/32/600) with its `count`, one
 * sentence `lede` (14/20 muted, at most 560px), and `actions` at the right:
 * one sm primary "New …", any others in a "…" menu. `toolbar` is the row
 * 16px below (SegmentedControl, SearchInput, filters). Content follows 24px
 * below. Settings keeps its own panel bar.
 */
export function PageHeader({
  title,
  titleId,
  count,
  lede,
  actions,
  toolbar,
}: {
  title: string;
  titleId?: string;
  count?: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
}) {
  return (
    <header data-slot="page-header">
      <div className="ui-page-header">
        <div className="ui-page-header-text">
          <div className="ui-page-header-title">
            {/* The narrow window's navigation button, before the title. */}
            <ShellLeading navOnly />
            <h1 id={titleId} tabIndex={titleId ? -1 : undefined}>
              {title}
            </h1>
            {count}
          </div>
          {lede && <p className="ui-page-header-lede">{lede}</p>}
        </div>
        <div className="ui-page-header-actions">
          <ShellNoticeSlot />
          {actions}
        </div>
      </div>
      {toolbar && <div className="ui-page-toolbar">{toolbar}</div>}
    </header>
  );
}

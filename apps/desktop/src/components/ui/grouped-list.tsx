import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Count } from "@/components/ui/count";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  type ShortcutId,
} from "@/lib/shortcuts";
import { EmptyState } from "@/components/ui/empty-state";
import { Pager } from "@/components/ui/pager";
import { FailureAlert } from "@/components/ui/failure-alert";
import type { GroupedListItemProps, usePagedGroup } from "./use-grouped-list";
import "./grouped-list.css";

/** A fold button that sits in the same roving order as the rows it heads. */
export function GroupHeader({
  label,
  count,
  open,
  onOpenChange,
  roving,
  foldShortcut,
}: {
  label: ReactNode;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roving: GroupedListItemProps;
  /** An optional registered Left/Right shortcut for closing and opening. */
  foldShortcut?: ShortcutId;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <h2 className="ui-group-header" data-slot="group-header">
      <button
        type="button"
        className="ui-group-toggle"
        {...roving}
        aria-expanded={open}
        aria-keyshortcuts={
          foldShortcut
            ? `${roving["aria-keyshortcuts"]} ${ariaKeyShortcuts(foldShortcut)}`
            : roving["aria-keyshortcuts"]
        }
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (foldShortcut && matchesShortcut(event, foldShortcut)) {
            event.preventDefault();
            event.stopPropagation();
            const next = event.key === "ArrowRight";
            if (next !== open) onOpenChange(next);
          } else {
            roving.onKeyDown(event);
          }
        }}
      >
        <Chevron aria-hidden="true" />
        <span className="ui-group-name">{label}</span> <Count>{count}</Count>
      </button>
    </h2>
  );
}

/** Presents the rows, loading status or failure of one lazy group. */
export function PagedGroupBody<T>({
  page,
  loadingText,
  noun,
  children,
}: {
  page: ReturnType<typeof usePagedGroup<T>>;
  loadingText: string;
  noun: string;
  children: (rows: T[]) => ReactNode;
}) {
  if (!page.open) return null;
  return (
    <>
      {page.failure ? (
        <FailureAlert
          size="compact"
          failure={page.failure}
          onRetry={page.retry}
        />
      ) : page.loaded ? (
        children(page.rows)
      ) : (
        <EmptyState size="inline" role="status" description={loadingText} />
      )}
      <Pager noun={noun} more={page.more} onMore={page.showMore} />
    </>
  );
}

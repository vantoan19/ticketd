import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BulkTagDialog } from "@/features/tickets/BulkTagDialog";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { directStatuses } from "@/lib/statuses";
import type { BulkEdit } from "@/features/tickets/useBulkEdit";
import type { TicketWorkspace } from "@/features/tickets/useTicketWorkspace";
import type { Ticket } from "@/lib/api/client";
import {
  useStatusLine,
  useStatusLineInset,
} from "@/components/ui/use-status-line";

/** The bar's height, kept free under the status line. */
const BAR_HEIGHT = 48;

const tickets = (count: number) =>
  `${count} ${count === 1 ? "ticket" : "tickets"}`;

/**
 * The bulk action bar, docked at the bottom of the list. Its outcome goes to
 * the pane's status line, which floats just above it: "Set 3 tickets to
 * Done", or the failure with Retry. Nothing shows at zero selected.
 */
export function BulkControls({
  bulk,
  visible,
  projects,
  plans,
}: {
  bulk: BulkEdit;
  /** Tickets currently listed, for Select all and Plan membership counts. */
  visible: Ticket[];
  projects: TicketWorkspace["projects"];
  plans: TicketWorkspace["plans"];
}) {
  const [tagMode, setTagMode] = useState<"add" | "remove" | null>(null);
  const { pending, failure, notice, selection } = bulk;
  const statusLine = useStatusLine();
  const count = selection.length;
  // The status line floats above the bar while the bar shows.
  useStatusLineInset(count > 0 || pending ? BAR_HEIGHT : 0);
  // The menu that started a change is disabled, then gone, while it applies.
  // Say where focus goes next: Retry after a failure, the list heading after
  // success (the status line announces the outcome).
  const retry = useRef(bulk.retry);
  useEffect(() => {
    retry.current = bulk.retry;
  });
  useEffect(() => {
    if (!failure) return;
    statusLine.show({
      tone: "error",
      message: failure.message,
      focusAction: true,
      ...(failure.retryable && {
        action: { label: "Retry", run: () => retry.current() },
      }),
    });
  }, [failure, statusLine]);
  useEffect(() => {
    if (!notice) return;
    statusLine.show({ message: notice });
    document.getElementById("tickets-heading")?.focus();
  }, [notice, statusLine]);
  // Esc clears the selection, unless a menu, dialog or text field has it.
  useEffect(() => {
    if (count === 0 || pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [role=combobox]"))
      )
        return;
      if (document.querySelector('[role="menu"], [role="dialog"]')) return;
      bulk.clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, pending, bulk]);
  const selectedTickets = visible.filter((ticket) =>
    selection.includes(ticket.reference),
  );
  const inStatus = (status: string) =>
    selectedTickets.filter((ticket) => ticket.status === status).length;
  const activePlans = plans.filter((item) => !item.archived);
  const inPlan = (id: string) =>
    selectedTickets.filter((ticket) => ticket.plan_id === id).length;
  const canSelectMore = visible.some(
    (ticket) => !selection.includes(ticket.reference),
  );
  const organize = (
    change: Parameters<BulkEdit["applyOrganization"]>[0],
    summary: string,
  ) => void bulk.applyOrganization(change, summary);

  return (
    <div
      id="bulk-controls"
      tabIndex={-1}
      className="bulk-controls"
      role="region"
      aria-label="Bulk edit"
      // Mounted while an outcome is still being posted; drawn only with a selection.
      hidden={count === 0 && !pending}
    >
      {count > 0 && (
        <div className="bulk-bar">
          <span className="bulk-count" aria-live="polite">
            {pending ? "Applying…" : `${count} selected`}
          </span>
          {canSelectMore && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              aria-label={`Select all ${visible.length}`}
              onClick={() =>
                bulk.selectAll(visible.map((ticket) => ticket.reference))
              }
            >
              <span className="bulk-long" aria-hidden="true">
                Select all {visible.length}
              </span>
              <span className="bulk-short" aria-hidden="true">
                All {visible.length}
              </span>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label="Status of selected tickets"
              >
                Status
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuLabel className="bulk-menu-label">
                Set status for {tickets(count)}
              </DropdownMenuLabel>
              {directStatuses.map((status) => {
                const here = inStatus(status);
                const all = here === count;
                return (
                  <DropdownMenuItem
                    key={status}
                    onSelect={() =>
                      void bulk.applyStatus(
                        status,
                        `Set ${tickets(count)} to ${status}`,
                      )
                    }
                  >
                    <StatusIcon status={status} decorative />
                    {status}
                    {here > 0 && (
                      <span className="bulk-menu-count">
                        {all
                          ? count === 2
                            ? "both"
                            : "all"
                          : `${here} of ${count}`}
                      </span>
                    )}
                    {all && (
                      <Check className="bulk-status-check" aria-hidden="true" />
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                className="bulk-organize"
                aria-label="Organize selected tickets"
              >
                Organize
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Move to project</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {projects.map((project) => (
                    <DropdownMenuItem
                      key={project.id}
                      onSelect={() =>
                        organize(
                          { project_id: project.id },
                          `Moved ${tickets(count)} to ${project.name}`,
                        )
                      }
                    >
                      {project.name}
                    </DropdownMenuItem>
                  ))}
                  {projects.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    onSelect={() =>
                      organize(
                        { project_id: null },
                        `Removed ${tickets(count)} from their project`,
                      )
                    }
                  >
                    No project
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Set Plan</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {activePlans.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onSelect={() =>
                        organize(
                          { plan_id: item.id },
                          `Added ${tickets(count)} to ${item.name}`,
                        )
                      }
                    >
                      {item.name}{" "}
                      <span className="bulk-menu-count">
                        {inPlan(item.id)} of {count}
                      </span>
                    </DropdownMenuItem>
                  ))}
                  {activePlans.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    onSelect={() =>
                      organize(
                        { plan_id: null },
                        `Removed ${tickets(count)} from their Plan`,
                      )
                    }
                  >
                    Remove from Plan
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setTagMode("add")}>
                Add tag…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTagMode("remove")}>
                Remove tag…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="bulk-spacer" />
          <Button
            variant="ghost"
            size="sm"
            className="bulk-clear"
            aria-label="Clear selection"
            title="Clear selection"
            disabled={pending}
            onClick={bulk.clearSelection}
          >
            <X className="bulk-clear-icon" aria-hidden="true" />
            <span className="bulk-clear-text">Clear</span>
            <kbd className="bulk-kbd" aria-hidden="true">
              Esc
            </kbd>
          </Button>
        </div>
      )}
      {pending && (
        <p className="sr-only" role="status">
          Applying…
        </p>
      )}
      <BulkTagDialog
        open={tagMode !== null}
        onOpenChange={(open) => !open && setTagMode(null)}
        count={count}
        mode={tagMode ?? "add"}
        onApply={(mode, tag) =>
          organize(
            mode === "add" ? { add_tags: [tag] } : { remove_tags: [tag] },
            mode === "add"
              ? `Added tag “${tag}” to ${tickets(count)}`
              : `Removed tag “${tag}” from ${tickets(count)}`,
          )
        }
      />
    </div>
  );
}

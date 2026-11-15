import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Folder, Layers, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
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
import { describeFailure } from "@/lib/api/describe-failure";
import {
  useStatusLine,
  useStatusLineInset,
} from "@/components/ui/use-status-line";

/** The floating bar's height and its gap, kept free under the status line. */
const BAR_HEIGHT = 48;

const tickets = (count: number) =>
  `${count} ${count === 1 ? "ticket" : "tickets"}`;

/**
 * The bulk action bar (S4): it floats 8px above the bottom of the list, on the
 * popover surface with the menu shadow, so the rows never move. "3 selected ·
 * Status · Organize · Select all 59 matching · ×". Its outcome takes the same
 * place in the pane's status line: "Set 3 tickets to Done", or the failure
 * with Retry; focus goes back to the list. Nothing shows at zero selected.
 */
export function BulkControls({
  bulk,
  visible,
  total,
  matchingReferences,
  projects,
  plans,
}: {
  bulk: BulkEdit;
  /** Tickets currently listed, for Select all and Plan membership counts. */
  visible: Ticket[];
  /** Every ticket the search and filters match, listed or not. */
  total: number;
  /** Reads every matching reference, for "Select all 59 matching". */
  matchingReferences: () => Promise<string[]>;
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
      // Plain words: the ticket that prevented it and that nothing changed.
      message: `${failure.description.title}. ${failure.description.sentence}`,
      focusAction: true,
      ...(failure.retryable && {
        action: { label: "Retry", run: () => retry.current() },
      }),
    });
  }, [failure, statusLine]);
  useEffect(() => {
    if (!notice) return;
    statusLine.show({ message: notice });
    // Back to the list, at its tab stop, never to a ringed heading (B-03).
    (
      document.querySelector<HTMLElement>('.ticket-row[tabindex="0"]') ??
      document.getElementById("tickets-heading")
    )?.focus({ preventScroll: true });
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
  // After the whole listed page, the rest of the result (list B-02).
  const canSelectMatching = !canSelectMore && total > selection.length;
  const [selecting, setSelecting] = useState(false);
  async function selectMatching() {
    setSelecting(true);
    try {
      bulk.selectAll(await matchingReferences());
    } catch (reason) {
      statusLine.show({
        tone: "error",
        message: `Couldn't select every matching ticket. ${describeFailure(reason, "select tickets").sentence}`,
      });
    } finally {
      setSelecting(false);
    }
  }
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
              onClick={() =>
                bulk.selectAll(visible.map((ticket) => ticket.reference))
              }
            >
              Select all {visible.length}
            </Button>
          )}
          {canSelectMatching && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending || selecting}
              onClick={() => void selectMatching()}
            >
              Select all {total} matching
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
              <DropdownMenuLabel>
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
                    {/* A check when every selected ticket has it; otherwise
                        how many do (list B-04). */}
                    {here > 0 && !all && (
                      <span className="bulk-menu-count">
                        {here} of {count}
                      </span>
                    )}
                    {all && (
                      <Check className="bulk-status-check" aria-hidden="true" />
                    )}
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <p className="bulk-menu-caption">
                Duplicate is set from a ticket’s review.
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label="Organize selected tickets"
              >
                Organize
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Folder aria-hidden="true" />
                  Move to project
                </DropdownMenuSubTrigger>
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
                <DropdownMenuSubTrigger>
                  <Layers aria-hidden="true" />
                  Set Plan
                </DropdownMenuSubTrigger>
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
                <Tag aria-hidden="true" />
                Add tag…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTagMode("remove")}>
                <X aria-hidden="true" />
                Remove tag…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <IconButton
            label="Clear selection"
            shortcut="Esc"
            aria-keyshortcuts="Escape"
            disabled={pending}
            onClick={bulk.clearSelection}
          >
            <X />
          </IconButton>
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

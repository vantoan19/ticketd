import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

const tickets = (count: number) =>
  `${count} ${count === 1 ? "ticket" : "tickets"}`;

/**
 * The floating bulk action bar. Nothing shows at zero selected unless a
 * confirmation or a failure still needs to be read.
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
  const [tagsOpen, setTagsOpen] = useState(false);
  const retry = useRef<HTMLButtonElement>(null);
  const failureNote = useRef<HTMLDivElement>(null);
  const { pending, failure, notice, selection } = bulk;
  // The menu that started a change is disabled, then gone, while it applies.
  // Say where focus goes next: Retry after a failure, the list heading after
  // success (its confirmation is already in the live region below).
  useEffect(() => {
    if (failure) (retry.current ?? failureNote.current)?.focus();
  }, [failure]);
  useEffect(() => {
    if (notice) document.getElementById("tickets-heading")?.focus();
  }, [notice]);
  const count = selection.length;
  const selectedTickets = visible.filter((ticket) =>
    selection.includes(ticket.reference),
  );
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
    >
      {count > 0 && (
        <div className="bulk-bar">
          <span className="bulk-count" aria-live="polite">
            {count} selected
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                aria-label="Status of selected tickets"
              >
                Status
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              {directStatuses.map((status) => (
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
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
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
                        `Unlinked ${tickets(count)} from their project`,
                      )
                    }
                  >
                    Unlinked
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
              <DropdownMenuItem onSelect={() => setTagsOpen(true)}>
                Add or remove tags…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <IconButton
            label="Clear selection"
            disabled={pending}
            onClick={bulk.clearSelection}
          >
            <X />
          </IconButton>
        </div>
      )}
      {pending && (
        <p className="bulk-message" role="status">
          Applying…
        </p>
      )}
      {failure && (
        <div
          ref={failureNote}
          tabIndex={-1}
          className="bulk-message bulk-error"
          role="alert"
        >
          <span>{failure.message}</span>
          {failure.retryable && (
            <Button
              ref={retry}
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void bulk.retry()}
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p className="bulk-message" role="status">
          {notice}.
        </p>
      )}
      <BulkTagDialog
        open={tagsOpen}
        onOpenChange={setTagsOpen}
        count={count}
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

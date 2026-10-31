import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { StatusIcon, ticketStatuses } from "@/features/tickets/StatusIcon";
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
  efforts,
}: {
  bulk: BulkEdit;
  /** Tickets currently listed, for Select all and Effort membership counts. */
  visible: Ticket[];
  projects: TicketWorkspace["projects"];
  efforts: TicketWorkspace["efforts"];
}) {
  const [tagsOpen, setTagsOpen] = useState(false);
  const { pending, failure, notice, selection } = bulk;
  const count = selection.length;
  const selectedTickets = visible.filter((ticket) =>
    selection.includes(ticket.reference),
  );
  const activeEfforts = efforts.filter((item) => !item.archived);
  const inEffort = (id: string) =>
    selectedTickets.filter((ticket) => ticket.effort_id === id).length;
  const canSelectMore = visible.some(
    (ticket) => !selection.includes(ticket.reference),
  );
  const organize = (
    change: Parameters<BulkEdit["applyOrganization"]>[0],
    summary: string,
  ) => void bulk.applyOrganization(change, summary);

  return (
    <div className="bulk-controls" role="region" aria-label="Bulk edit">
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
                aria-label="Change status of selected tickets"
              >
                Status
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              {ticketStatuses.map((status) => (
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
                <DropdownMenuSubTrigger>Set Effort</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {activeEfforts.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onSelect={() =>
                        organize(
                          { effort_id: item.id },
                          `Added ${tickets(count)} to ${item.name}`,
                        )
                      }
                    >
                      {item.name}{" "}
                      <span className="bulk-menu-count">
                        {inEffort(item.id)} of {count}
                      </span>
                    </DropdownMenuItem>
                  ))}
                  {activeEfforts.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    onSelect={() =>
                      organize(
                        { effort_id: null },
                        `Removed ${tickets(count)} from their Effort`,
                      )
                    }
                  >
                    Remove from Effort
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setTagsOpen(true)}>
                Add or remove tags…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear selection"
            disabled={pending}
            onClick={bulk.clearSelection}
          >
            <X />
          </Button>
        </div>
      )}
      {pending && (
        <p className="bulk-message" role="status">
          Applying…
        </p>
      )}
      {failure && (
        <div className="bulk-message bulk-error" role="alert">
          <span>{failure.message}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void bulk.retry()}
          >
            Retry
          </Button>
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

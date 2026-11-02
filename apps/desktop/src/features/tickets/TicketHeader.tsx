import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Check,
  Copy,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useCopy } from "@/components/ui/use-copy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Duplicates } from "@/features/tickets/Duplicates";
import { SourceLink } from "@/features/tickets/SourceLink";
import {
  externalSource,
  sourceLocation,
} from "@/features/tickets/ticket-source";
import { client, type Ticket } from "@/lib/api/client";
import "./ticket-detail.css";

/** The shell command an agent runs to read this ticket's context. */
function contextCommand(reference: string): string {
  return `ticketd context ${reference} --relationships --notes --evidence`;
}

/** The reference, personal actions, actions menu, and pane controls of a ticket. */
export function TicketHeader({
  selected,
  ticket,
  expanded,
  onExpand,
  onReturn,
  onClose,
  onOpenGraph,
  refresh,
  updateTicket,
  position = null,
  onAdjacent,
}: {
  /** The selected ticket's place in the visible list, across pages. */
  position?: { index: number; total: number } | null;
  /** Opens the ticket before (-1) or after (1) this one in the list. */
  onAdjacent?: (direction: 1 | -1) => void;
  selected: string | null;
  ticket: Ticket | undefined;
  expanded: boolean;
  onExpand: () => void;
  onReturn: () => void;
  onClose: () => void;
  onOpenGraph: () => void;
  refresh: () => Promise<void>;
  updateTicket: (ticket: Ticket) => void;
}) {
  const { copied, error: copyError, copy } = useCopy();
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  // Previous/Next replace the ticket (and, at a page edge, the page), which
  // remounts this group. Remember which one the keyboard used and give it focus back.
  const listPosition = useRef<HTMLDivElement>(null);
  const adjacentFocus = useRef<{
    label: "Previous ticket" | "Next ticket";
    from: string | null;
  } | null>(null);
  useEffect(() => {
    const wanted = adjacentFocus.current;
    // Wait for the neighboring ticket to be the loaded, selected one.
    if (!wanted || !ticket || selected === wanted.from) return;
    adjacentFocus.current = null;
    listPosition.current
      ?.querySelector<HTMLButtonElement>(`button[aria-label="${wanted.label}"]`)
      ?.focus();
  }, [selected, ticket, position]);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  async function setTrashed(value: boolean) {
    if (!ticket) return;
    setPending(true);
    setActionError("");
    try {
      updateTicket(await client.setTrashed(ticket.reference, value));
      await refresh();
    } catch (reason) {
      setActionError(
        `Could not ${value ? "move to trash" : "restore"}: ${String(reason)}`,
      );
    } finally {
      setPending(false);
    }
  }
  const owner = ticket ? externalSource(ticket) : null;
  const message = actionError || copyError;
  return (
    <div className="detail-header">
      <div className="detail-title-group">
        {selected && (
          <IconButton
            className="return-to-list"
            label="Return to ticket list"
            onClick={onReturn}
          >
            <ArrowLeft size={16} />
          </IconButton>
        )}
        <h2
          id="detail-heading"
          tabIndex={-1}
          className={selected ? "detail-reference" : undefined}
        >
          {selected ?? "Ticket details"}
        </h2>
        {selected && (
          <IconButton
            className="copy-reference"
            label="Copy reference"
            onClick={() => void copy("Reference", selected)}
          >
            {copied === "Reference" ? <Check /> : <Copy />}
          </IconButton>
        )}
        {owner && (
          <SourceLink url={owner.url} className="header-source-link">
            <span className="sr-only">Open on {owner.provider_name}: </span>
            {sourceLocation(owner)}
          </SourceLink>
        )}
      </div>
      {ticket && (
        <div className="ticket-personal-actions">
          {position && onAdjacent && (
            <div
              ref={listPosition}
              className="list-position"
              role="group"
              aria-label="Position in the list"
            >
              <span className="list-position-text">
                {position.index} of {position.total}
              </span>
              <IconButton
                label="Previous ticket"
                disabled={position.index <= 1}
                onClick={() => {
                  adjacentFocus.current = {
                    label: "Previous ticket",
                    from: selected,
                  };
                  onAdjacent(-1);
                }}
              >
                <ChevronUp />
              </IconButton>
              <IconButton
                label="Next ticket"
                disabled={position.index >= position.total}
                onClick={() => {
                  adjacentFocus.current = {
                    label: "Next ticket",
                    from: selected,
                  };
                  onAdjacent(1);
                }}
              >
                <ChevronDown />
              </IconButton>
            </div>
          )}
          {ticket.trashed && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void setTrashed(false)}
            >
              Restore
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                ref={actionsTrigger}
                label="Ticket actions"
                disabled={pending}
              >
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onSelect={() => void copy("Reference", ticket.reference)}
                >
                  Copy reference
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void copy(
                      "Context command",
                      contextCommand(ticket.reference),
                    )
                  }
                >
                  Copy context command
                </DropdownMenuItem>
                {!ticket.trashed && (
                  <>
                    <DropdownMenuItem onSelect={() => setDuplicateOpen(true)}>
                      Mark as duplicate…
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onOpenGraph}>
                      Open dependency graph
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {ticket.trashed ? (
                  <DropdownMenuItem onSelect={() => void setTrashed(false)}>
                    Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void setTrashed(true)}
                  >
                    Move to trash
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {selected && (
        <div className="detail-actions">
          {expanded ? (
            <IconButton label="Show beside the list" onClick={onReturn}>
              <Minimize2 />
            </IconButton>
          ) : (
            <IconButton
              className="expand-ticket"
              label="Expand ticket"
              onClick={onExpand}
            >
              <Maximize2 />
            </IconButton>
          )}
          <IconButton label="Close ticket details" onClick={onClose}>
            <X />
          </IconButton>
        </div>
      )}
      {(message || copied) && (
        <p
          className="detail-header-message"
          role={message ? "alert" : "status"}
        >
          {message || `${copied} copied`}
        </p>
      )}
      {ticket && (
        <Dialog open={duplicateOpen} onOpenChange={setDuplicateOpen}>
          <DialogContent
            className="duplicate-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              actionsTrigger.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Mark as duplicate</DialogTitle>
              <DialogDescription>
                Choose the canonical ticket for {ticket.reference} and review
                its dependencies.
              </DialogDescription>
            </DialogHeader>
            <Duplicates
              ticket={ticket}
              refresh={refresh}
              onDone={() => setDuplicateOpen(false)}
              onCancel={() => setDuplicateOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

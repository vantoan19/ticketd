import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Follow } from "@/features/tickets/Inbox";
import { Reminder } from "@/features/tickets/Reminder";
import { client, type Ticket } from "@/lib/api/client";
import "./ticket-detail.css";

/** The shell command an agent runs to read this ticket's context. */
function contextCommand(reference: string): string {
  return `ticketd context ${reference}`;
}

/** Copies text and reports success or failure for a short confirmation. */
function useCopy() {
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy(label: string, text: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setError("");
      setCopied(label);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(""), 2000);
    } catch (reason) {
      setCopied("");
      setError(`Could not copy ${label.toLowerCase()}: ${String(reason)}`);
    }
  }
  return { copied, error, copy };
}

/** The reference, personal actions, actions menu, and pane controls of a ticket. */
export function TicketHeader({
  selected,
  ticket,
  expanded,
  revision,
  onExpand,
  onReturn,
  onClose,
  onOpenGraph,
  refresh,
  updateTicket,
}: {
  selected: string | null;
  ticket: Ticket | undefined;
  expanded: boolean;
  revision: number;
  onExpand: () => void;
  onReturn: () => void;
  onClose: () => void;
  onOpenGraph: () => void;
  select: (reference: string | null) => void;
  refresh: () => Promise<void>;
  updateTicket: (ticket: Ticket) => void;
}) {
  const { copied, error: copyError, copy } = useCopy();
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
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
  const message = actionError || copyError;
  return (
    <div className="detail-header">
      <div className="detail-title-group">
        {selected && (
          <button
            className="icon-button return-to-list"
            aria-label="Return to ticket list"
            onClick={onReturn}
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <h2
          id="detail-heading"
          tabIndex={-1}
          className={selected ? "detail-reference" : undefined}
        >
          {selected ?? "Ticket details"}
        </h2>
        {selected && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy reference"
            onClick={() => void copy("Reference", selected)}
          >
            {copied === "Reference" ? <Check /> : <Copy />}
          </Button>
        )}
      </div>
      {ticket && (
        <div className="ticket-personal-actions">
          <Follow
            key={`follow-${ticket.reference}`}
            reference={ticket.reference}
            revision={revision}
          />
          <Reminder
            key={`reminder-${ticket.reference}`}
            reference={ticket.reference}
            revision={revision}
          />
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
              <Button
                ref={actionsTrigger}
                variant="ghost"
                size="icon-sm"
                aria-label="Ticket actions"
                disabled={pending}
              >
                <MoreHorizontal />
              </Button>
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
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Show beside the list"
              onClick={onReturn}
            >
              <Minimize2 />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              className="expand-ticket"
              aria-label="Expand ticket"
              onClick={onExpand}
            >
              <Maximize2 />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close ticket details"
            onClick={onClose}
          >
            <X />
          </Button>
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

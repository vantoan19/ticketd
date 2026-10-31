import { useRef, type ReactNode } from "react";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusIcon } from "./StatusIcon";
import {
  readiness,
  readinessLabel,
  rowContext,
  type RowScope,
} from "./ticket-row";
import type { Ticket } from "@/lib/api/client";
import "./ticket-list.css";

export function TicketList({
  tickets,
  selected,
  onOpen,
  bulkSelection,
  onToggle,
  selectable,
  selectionDisabled = false,
  scope,
  rowAction,
}: {
  tickets: Ticket[];
  selected: string | null;
  onOpen: (reference: string) => void;
  bulkSelection: string[];
  onToggle: (reference: string) => void;
  selectable: boolean;
  selectionDisabled?: boolean;
  scope: RowScope;
  /** An optional control after each row, revealed on hover and keyboard focus. */
  rowAction?: (ticket: Ticket) => ReactNode;
}) {
  const rows = useRef(new Map<string, HTMLButtonElement>());
  return (
    <TooltipProvider delayDuration={400}>
      <ul className="ticket-rows">
        {tickets.map((ticket, index) => {
          return (
            <li key={ticket.id}>
              {selectable && (
                <label className="ticket-select">
                  <input
                    type="checkbox"
                    aria-label={`Select ${ticket.reference}`}
                    checked={bulkSelection.includes(ticket.reference)}
                    disabled={selectionDisabled}
                    onChange={() => onToggle(ticket.reference)}
                  />
                </label>
              )}
              <button
                ref={(node) => {
                  if (node) rows.current.set(ticket.id, node);
                  else rows.current.delete(ticket.id);
                }}
                type="button"
                className="ticket-row"
                aria-pressed={ticket.reference === selected}
                onClick={() => onOpen(ticket.reference)}
                onFocus={(event) =>
                  event.currentTarget.scrollIntoView?.({ block: "nearest" })
                }
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const next =
                      tickets[index + (event.key === "ArrowDown" ? 1 : -1)];
                    if (next) rows.current.get(next.id)?.focus();
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    onOpen(ticket.reference);
                  }
                }}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="ticket-row-status">
                      <StatusIcon status={ticket.status} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{ticket.status}</TooltipContent>
                </Tooltip>
                <span className="ticket-ref">{ticket.reference}</span>
                <span className="ticket-title" title={ticket.title}>
                  {ticket.title}
                </span>
                <RowDetails ticket={ticket} scope={scope} />
              </button>
              {rowAction && (
                <span className="ticket-row-action">{rowAction(ticket)}</span>
              )}
            </li>
          );
        })}
      </ul>
    </TooltipProvider>
  );
}

function RowDetails({ ticket, scope }: { ticket: Ticket; scope: RowScope }) {
  const state = readiness(ticket);
  const context = rowContext(ticket, scope);
  return (
    <span className="ticket-row-meta">
      <span className="ticket-row-state">
        {state.kind !== "status" && <StatusDot tone={state.kind} size={8} />}
        {readinessLabel(state)}
      </span>
      {context && <span className="ticket-row-context">{context}</span>}
      {ticket.tags.map((tag) => (
        <span key={tag} className="ticket-tag">
          {tag}
        </span>
      ))}
    </span>
  );
}

import { useRef } from "react";
import { CheckCircle2, Circle, CircleDot, CircleSlash, CircleDashed, type LucideIcon } from "lucide-react";
import type { Ticket } from "@/lib/api/client";
import "./ticket-list.css";

const statusIcons: Record<string, LucideIcon> = {
  Todo: Circle,
  "In progress": CircleDot,
  "In review": CircleDashed,
  Done: CheckCircle2,
  Canceled: CircleSlash,
};

export function TicketList({ tickets, selected, onOpen }: { tickets: Ticket[]; selected: string | null; onOpen: (reference: string) => void }) {
  const rows = useRef(new Map<string, HTMLButtonElement>());
  return (
    <ul className="ticket-rows">
      {tickets.map((ticket, index) => {
        const StatusIcon = statusIcons[ticket.status] ?? Circle;
        return (
          <li key={ticket.id}>
            <button
              ref={(node) => { if (node) rows.current.set(ticket.id, node); else rows.current.delete(ticket.id); }}
              type="button"
              className="ticket-row"
              aria-pressed={ticket.reference === selected}
              onClick={() => onOpen(ticket.reference)}
              onFocus={(event) => event.currentTarget.scrollIntoView?.({ block: "nearest" })}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = tickets[index + (event.key === "ArrowDown" ? 1 : -1)];
                  if (next) rows.current.get(next.id)?.focus();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  onOpen(ticket.reference);
                }
              }}
            >
              <span className="ticket-row-status"><StatusIcon aria-hidden="true" size={16} /><span>{ticket.status}</span></span>
              <span className="ticket-ref">{ticket.reference}</span>
              <span className="ticket-title" title={ticket.title}>{ticket.title}</span>
              <span className="ticket-row-meta">
                {ticket.status === "Todo" && ticket.availability && <span>{ticket.availability}</span>}
                {ticket.parent && <span>Parent: {ticket.parent.reference}{ticket.parent.trashed ? " (trashed)" : ""}</span>}
                {ticket.tags.length > 0 && <span>{ticket.tags.join(", ")}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

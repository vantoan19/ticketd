import { useNow } from "@/lib/use-now";
import { useRef, type ReactNode } from "react";
import {
  Cloud,
  Copy,
  CornerDownRight,
  Folder,
  Layers,
  Plus,
} from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusIcon } from "./StatusIcon";
import { ago, externalSource } from "./ticket-source";
import { groupTickets } from "./ticket-groups";
import {
  readiness,
  readinessLabel,
  readinessShortLabel,
  rowContextItem,
  type RowContextKind,
  type RowScope,
} from "./ticket-row";
import { formatDateTime } from "@/lib/format";
import type { StatusCounts, Ticket } from "@/lib/api/client";
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
  grouping,
  singleStatus = false,
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
  /**
   * Group the rows by status, with the counts of the whole result and an Add
   * action per group. Without it the list is flat and each row names its status.
   */
  grouping?: {
    counts: StatusCounts;
    /** Omit to hide the per-group Add action (a read-only scope). */
    onAdd?: (status: string, trigger: HTMLButtonElement) => void;
  };
  /**
   * The view lists one status (Ready, In progress): no group header and no
   * per-row Ready dot or status word, since the view's title says it.
   */
  singleStatus?: boolean;
}) {
  const rows = useRef(new Map<string, HTMLButtonElement>());
  // Groups and rows share one list so a row that changes group keeps its
  // element and the list keeps its scroll position.
  const entries: (
    { header: ReturnType<typeof groupTickets>[number] } | { ticket: Ticket }
  )[] =
    grouping && !singleStatus
      ? groupTickets(tickets, grouping.counts).flatMap((group) => [
          { header: group },
          ...group.tickets.map((ticket) => ({ ticket })),
        ])
      : tickets.map((ticket) => ({ ticket }));
  const ordered = entries.flatMap((entry) =>
    "ticket" in entry ? [entry.ticket] : [],
  );
  return (
    <TooltipProvider delayDuration={400}>
      <ul className="ticket-rows">
        {entries.map((entry) => {
          if ("header" in entry) {
            const { status, count, tickets: shown } = entry.header;
            return (
              <li
                key={`group-${status}`}
                className="ticket-group-header"
                data-status={status}
              >
                <StatusIcon status={status} decorative />
                <h2>{status}</h2>
                <span className="ticket-group-count">
                  {shown.length < count ? `${shown.length} of ${count}` : count}
                  <span className="sr-only">
                    {" "}
                    {count === 1 ? "ticket" : "tickets"}
                  </span>
                </span>
                {grouping?.onAdd && (
                  <IconButton
                    className="ticket-group-add"
                    // Every group offers the same action; the Duplicate group's
                    // opens the review that names the canonical ticket.
                    label={`Add ${status} ticket`}
                    onClick={(event) =>
                      grouping.onAdd?.(status, event.currentTarget)
                    }
                  >
                    <Plus aria-hidden="true" />
                  </IconButton>
                )}
              </li>
            );
          }
          const { ticket } = entry;
          const index = ordered.indexOf(ticket);
          return (
            <li key={ticket.id}>
              {selectable && (
                <label className="ticket-select">
                  <input
                    type="checkbox"
                    tabIndex={-1}
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
                      ordered[index + (event.key === "ArrowDown" ? 1 : -1)];
                    if (next) rows.current.get(next.id)?.focus();
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    onOpen(ticket.reference);
                  } else if (
                    event.key === " " &&
                    selectable &&
                    !selectionDisabled
                  ) {
                    // Space selects for bulk actions; Enter opens.
                    event.preventDefault();
                    onToggle(ticket.reference);
                  }
                }}
                onKeyUp={(event) => {
                  // Stop the native Space-click that would open the ticket.
                  if (event.key === " " && selectable && !selectionDisabled)
                    event.preventDefault();
                }}
                aria-keyshortcuts={selectable ? "Space Enter" : undefined}
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
                <SourcePill ticket={ticket} />
                <RowDetails
                  ticket={ticket}
                  scope={scope}
                  grouped={grouping !== undefined}
                  singleStatus={singleStatus}
                />
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

/** The owner of an externally owned ticket; a local ticket has no pill. */
function SourcePill({ ticket }: { ticket: Ticket }) {
  const source = externalSource(ticket);
  if (!source) return null;
  return (
    <span
      className="ticket-source-pill"
      title={`Owned by ${source.provider_name}: ${source.display}`}
    >
      <span className="sr-only">
        Owned by {source.provider_name}, {source.number}
      </span>
      <Cloud aria-hidden="true" />
      <span aria-hidden="true">{source.number}</span>
    </span>
  );
}

function ContextIcon({ kind }: { kind: RowContextKind }) {
  const props = { "aria-hidden": true } as const;
  if (kind === "duplicate") return <Copy {...props} />;
  if (kind === "subticket") return <CornerDownRight {...props} />;
  return kind === "plan" ? <Layers {...props} /> : <Folder {...props} />;
}

/** Line two, always in the same order: availability, context, tags, time. */
function RowDetails({
  ticket,
  scope,
  grouped,
  singleStatus,
}: {
  ticket: Ticket;
  scope: RowScope;
  grouped: boolean;
  singleStatus: boolean;
}) {
  const now = useNow();
  const state = readiness(ticket);
  const context = rowContextItem(ticket, scope);
  const unavailable = Boolean(externalSource(ticket)?.unavailable);
  const showState =
    // A single-status view already says Ready or the status; Blocked is still news.
    state.kind === "blocked" ||
    (!singleStatus &&
      (state.kind !== "status" ||
        (!grouped && !context?.label.startsWith("Duplicate"))));
  return (
    <span className="ticket-row-meta">
      <span className="ticket-row-contextual">
        {unavailable ? (
          // The source cannot be read: say so in place of Ready or Blocked, which
          // would describe content that may no longer be current.
          <span className="ticket-row-state">
            <StatusDot tone="attention" size={10} />
            {state.kind === "status" && !grouped && !singleStatus
              ? `${state.status} · Source unavailable`
              : "Source unavailable"}
          </span>
        ) : (
          showState && (
            <span className="ticket-row-state">
              {state.kind !== "status" && (
                <StatusDot tone={state.kind} size={10} />
              )}
              <span
                className="ticket-row-state-label"
                title={readinessLabel(state)}
              >
                {readinessShortLabel(state) === readinessLabel(state) ? (
                  readinessLabel(state)
                ) : (
                  <>
                    <span aria-hidden="true">{readinessShortLabel(state)}</span>
                    <span className="sr-only">{readinessLabel(state)}</span>
                  </>
                )}
              </span>
            </span>
          )
        )}
        {context && (
          <span className="ticket-row-context" data-kind={context.kind}>
            <ContextIcon kind={context.kind} />
            <span className="ticket-row-context-label">{context.label}</span>
          </span>
        )}
        {ticket.tags.length > 0 && (
          <span className="ticket-row-tags">
            {ticket.tags.map((tag) => (
              <span key={tag} className="ticket-tag">
                {tag}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="ticket-row-time">
        {ticket.updated_at ? (
          <time
            dateTime={ticket.updated_at}
            title={formatDateTime(ticket.updated_at)}
          >
            {ticket.trashed ? "Trashed" : "Updated"}{" "}
            {ago(ticket.updated_at, now)}
          </time>
        ) : (
          "Update time unknown"
        )}
      </span>
    </span>
  );
}

import { useNarrowPane } from "./useNarrowPane";
import { useNow } from "@/lib/use-now";
import { useRef, useState, type ReactNode } from "react";
import { Cloud, CornerDownRight, Folder, Layers, Plus } from "lucide-react";
import { Item } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusIcon } from "./StatusIcon";
import { RowTags } from "./RowTags";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { progressBrief } from "./progress-brief";
import { ago, externalSource } from "./ticket-source";
import { groupTickets } from "./ticket-groups";
import {
  readiness,
  readinessLabel,
  rowContextItem,
  type RowContextKind,
  type RowScope,
} from "./ticket-row";
import { compactAgo, formatDateTime } from "@/lib/format";
import type { StatusCounts, Ticket } from "@/lib/api/client";
import "./ticket-list.css";
import { Badge } from "@/components/ui/badge";
import { Count } from "@/components/ui/count";
import { Reference } from "@/components/ui/reference";
import { useConflicts } from "@/features/sync-review/use-conflicts";

export function TicketList({
  tickets,
  selected,
  onOpen,
  bulkSelection,
  onToggle,
  onSelectMany,
  selectable,
  selectionDisabled = false,
  scope,
  rowAction,
  grouping,
  singleStatus = false,
  simple = true,
}: {
  tickets: Ticket[];
  selected: string | null;
  onOpen: (reference: string) => void;
  bulkSelection: string[];
  onToggle: (reference: string) => void;
  /**
   * Adds several tickets to the selection: a Shift-click or Shift+↑/↓ range
   * from the last one toggled, or Mod+A for every listed ticket.
   */
  onSelectMany?: (references: string[]) => void;
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
   * The view lists one status (Ready, In progress, or a status filter): no
   * group header and no per-row status word, since the view's title says it.
   * A Todo row still carries Ready or Blocked.
   */
  singleStatus?: boolean;
  /** Every row is Ready (the Ready view), so the per-row Ready dot is omitted. */
  readyView?: boolean;
  /** Simple rows: one line, ending with the Ready or Blocked dot and the time. */
  simple?: boolean;
}) {
  const listElement = useRef<HTMLUListElement>(null);
  const narrow = useNarrowPane(listElement, 481);
  const { conflicts } = useConflicts();
  const needsReview = new Set(
    conflicts.filter((item) => item.kind === "ticket").map((item) => item.id),
  );
  const rows = useRef(new Map<string, HTMLButtonElement>());
  // The list is one Tab stop (roving tabindex, list R-08): the row last
  // focused, else the open ticket, else the first row.
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
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
  const tabStop =
    ordered.find((ticket) => ticket.id === focusedRow)?.id ??
    ordered.find((ticket) => ticket.reference === selected)?.id ??
    ordered[0]?.id;
  const focusRow = (ticket: Ticket | undefined) => {
    if (ticket) rows.current.get(ticket.id)?.focus();
  };
  // Where a Shift range starts: the ticket last toggled by itself.
  const anchor = useRef<string | null>(null);
  // A Shift-click already applied its range; its change event must not toggle.
  const ranged = useRef(false);
  const range = (to: Ticket) => {
    const from = ordered.findIndex((item) => item.reference === anchor.current);
    const end = ordered.indexOf(to);
    if (from < 0 || end < 0) return [to.reference];
    const [low, high] = from < end ? [from, end] : [end, from];
    return ordered.slice(low, high + 1).map((item) => item.reference);
  };
  const canSelect = selectable && !selectionDisabled;
  return (
    <ul ref={listElement} className="ticket-rows">
      {entries.map((entry) => {
        if ("header" in entry) {
          const { status, count, tickets: shown } = entry.header;
          // Ready is summarised here, not repeated on every row (list R-10);
          // only a whole group can say how many are ready.
          const ready =
            status === "Todo" && shown.length === count
              ? shown.filter((ticket) => readiness(ticket).kind === "ready")
                  .length
              : 0;
          return (
            <Item key={`group-${status}`} variant="ledger-group" asChild>
              <li className="ticket-group-header" data-status={status}>
                <StatusIcon status={status} decorative />
                <h2>{status}</h2>
                {/* Always the group's total, never the part shown (list R-09). */}
                <Count>
                  {count}
                  <span className="sr-only">
                    {" "}
                    {count === 1 ? "ticket" : "tickets"}
                  </span>
                </Count>
                {status === "Todo" && shown.length === count && (
                  <span className="ticket-group-meta">· {ready} ready</span>
                )}
                {grouping?.onAdd && (
                  // Revealed on header hover or focus; it stays in the tab order.
                  <span className="ticket-group-add">
                    <IconButton
                      // The Duplicate group's action names what it opens (R-03).
                      label={
                        status === "Duplicate"
                          ? "Mark a ticket as duplicate…"
                          : `Add ${status} ticket`
                      }
                      onClick={(event) =>
                        grouping.onAdd?.(status, event.currentTarget)
                      }
                    >
                      <Plus aria-hidden="true" />
                    </IconButton>
                  </span>
                )}
              </li>
            </Item>
          );
        }
        const { ticket } = entry;
        const index = ordered.indexOf(ticket);
        return (
          <Item
            key={ticket.id}
            variant={selected || narrow ? "navigator" : "ledger"}
            asChild
          >
            <li>
              {!selectable && (
                // Keeps rows aligned with lists that have a selection column.
                <span className="ticket-select" aria-hidden="true" />
              )}
              {selectable && (
                <label className="ticket-select">
                  <input
                    type="checkbox"
                    tabIndex={-1}
                    aria-label={`Select ${ticket.reference}`}
                    checked={bulkSelection.includes(ticket.reference)}
                    disabled={selectionDisabled}
                    onClick={(event) => {
                      // Shift-click selects the range from the last ticket toggled.
                      if (event.shiftKey && anchor.current && onSelectMany) {
                        event.preventDefault();
                        ranged.current = true;
                        window.setTimeout(() => (ranged.current = false), 0);
                        onSelectMany(range(ticket));
                      }
                    }}
                    onChange={() => {
                      if (ranged.current) {
                        ranged.current = false;
                        return;
                      }
                      anchor.current = ticket.reference;
                      onToggle(ticket.reference);
                    }}
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
                data-ticket-reference={ticket.reference}
                data-rows={simple ? "simple" : "detailed"}
                data-status={ticket.status}
                aria-pressed={ticket.reference === selected}
                tabIndex={ticket.id === tabStop ? 0 : -1}
                onClick={() => onOpen(ticket.reference)}
                onFocus={(event) => {
                  setFocusedRow(ticket.id);
                  event.currentTarget.scrollIntoView?.({ block: "nearest" });
                }}
                onKeyDown={(event) => {
                  const plain =
                    !event.metaKey && !event.ctrlKey && !event.altKey;
                  if (
                    canSelect &&
                    onSelectMany &&
                    event.shiftKey &&
                    (event.key === "ArrowDown" || event.key === "ArrowUp")
                  ) {
                    // Shift+↑/↓ extends the selection as focus moves.
                    event.preventDefault();
                    const next =
                      ordered[index + (event.key === "ArrowDown" ? 1 : -1)];
                    if (!next) return;
                    anchor.current ??= ticket.reference;
                    onSelectMany(range(next));
                    focusRow(next);
                  } else if (
                    canSelect &&
                    onSelectMany &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.altKey &&
                    event.key.toLowerCase() === "a"
                  ) {
                    // Mod+A selects every listed ticket.
                    event.preventDefault();
                    onSelectMany(ordered.map((item) => item.reference));
                  } else if (
                    event.key === "ArrowDown" ||
                    event.key === "ArrowUp" ||
                    (plain && (event.key === "j" || event.key === "k"))
                  ) {
                    event.preventDefault();
                    const down = event.key === "ArrowDown" || event.key === "j";
                    const next = ordered[index + (down ? 1 : -1)];
                    focusRow(next);
                    if (selected && next) onOpen(next.reference);
                  } else if (event.key === "Home" || event.key === "End") {
                    event.preventDefault();
                    focusRow(
                      event.key === "Home" ? ordered[0] : ordered.at(-1),
                    );
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
                    anchor.current = ticket.reference;
                    onToggle(ticket.reference);
                  }
                }}
                onKeyUp={(event) => {
                  // Stop the native Space-click that would open the ticket.
                  if (event.key === " " && selectable && !selectionDisabled)
                    event.preventDefault();
                }}
                aria-keyshortcuts={
                  selectable
                    ? "Space Enter Shift+ArrowDown Shift+ArrowUp Meta+A Control+A"
                    : undefined
                }
              >
                {grouping && !singleStatus ? (
                  // The group header already names the status (list R-02).
                  <span className="ticket-row-status">
                    <StatusIcon status={ticket.status} />
                  </span>
                ) : (
                  <Tooltip content={ticket.status}>
                    <span className="ticket-row-status">
                      <StatusIcon status={ticket.status} />
                    </span>
                  </Tooltip>
                )}
                <Reference>{ticket.reference}</Reference>

                <span className="ticket-title-lane">
                  <Tooltip content={ticket.title} overflowOnly>
                    <span className="ticket-title">{ticket.title}</span>
                  </Tooltip>
                  <SourcePill ticket={ticket} />
                </span>
                <RowDetails
                  ticket={ticket}
                  scope={scope}
                  simple={simple}
                  needsReview={needsReview.has(ticket.id)}
                />
              </button>
              {rowAction && (
                <span className="ticket-row-action">{rowAction(ticket)}</span>
              )}
            </li>
          </Item>
        );
      })}
    </ul>
  );
}

/** The owner of an externally owned ticket; a local ticket has no pill. */
export function SourcePill({ ticket }: { ticket: Ticket }) {
  const source = externalSource(ticket);
  if (!source) return null;
  return (
    <Tooltip content={`Owned by ${source.provider_name}: ${source.display}`}>
      <Badge
        variant="source"
        // Raised: the pill keeps its fill when the row is hovered or selected.
        tone="raised"
      >
        <span className="sr-only">
          Owned by {source.provider_name}, {source.number}
        </span>
        <Cloud aria-hidden="true" />
        <span aria-hidden="true">{source.number}</span>
      </Badge>
    </Tooltip>
  );
}

function ContextIcon({ kind }: { kind: RowContextKind | "unlinked" }) {
  const props = { "aria-hidden": true } as const;
  // The Duplicate status glyph, never a copy icon (list R-06).
  if (kind === "duplicate")
    return <StatusIcon status="Duplicate" size={12} decorative />;
  if (kind === "subticket") return <CornerDownRight {...props} />;
  if (kind === "unlinked") return <Folder {...props} strokeDasharray="2 3" />;
  return kind === "plan" ? <Layers {...props} /> : <Folder {...props} />;
}

/** Ledger lanes stay in the same order for both row densities. */
function RowDetails({
  ticket,
  scope,
  simple,
  needsReview,
}: {
  ticket: Ticket;
  scope: RowScope;
  simple: boolean;
  needsReview: boolean;
}) {
  const now = useNow();
  const state = readiness(ticket);
  const context = rowContextItem(ticket, scope, false);
  const duplicate = rowContextItem(ticket, scope);
  const unavailable = Boolean(externalSource(ticket)?.unavailable);
  const contextLabel =
    context?.label ?? (ticket.project_id ? "" : "No project");
  const label = needsReview
    ? "Needs review"
    : unavailable
      ? "Source unavailable"
      : state.kind === "blocked"
        ? readinessLabel(state)
        : duplicate?.kind === "duplicate"
          ? duplicate.label
          : "";
  const update = ticket.progress_summary;
  return (
    <>
      <span className="ticket-navigator-caption">
        <Reference>{ticket.reference}</Reference>
        <span>·</span>
        <span>
          {label ||
            (update
              ? `${update.editing_agent ?? "You"} · ${progressBrief(update.brief.text)}`
              : contextLabel)}
        </span>
      </span>
      <span className="ticket-row-state" aria-label={label || undefined}>
        {label && (
          <Tooltip content={label}>
            <span className="ticket-row-state-content">
              {duplicate?.kind === "duplicate" &&
              !needsReview &&
              !unavailable ? (
                <StatusIcon status="Duplicate" size={12} decorative />
              ) : (
                <StatusDot tone="attention" size={6} />
              )}
              <span className="ticket-row-state-label">{label}</span>
            </span>
          </Tooltip>
        )}
      </span>
      <span className="ticket-row-tags-lane">
        <RowTags tags={ticket.tags} ledger />
      </span>
      <span className="ticket-row-context" data-kind={context?.kind}>
        {contextLabel && (
          <>
            <ContextIcon kind={context?.kind ?? "unlinked"} />
            <span className="ticket-row-context-label">{contextLabel}</span>
          </>
        )}
      </span>
      <span className="ticket-row-time">
        {ticket.updated_at ? (
          <Tooltip content={formatDateTime(ticket.updated_at)}>
            <time dateTime={ticket.updated_at}>
              <span className="sr-only">
                {ticket.trashed ? "Trashed" : "Updated"}{" "}
                {ago(ticket.updated_at, now)}
              </span>
              <span aria-hidden="true">
                {ticket.trashed ? "Trashed " : ""}
                {compactAgo(ticket.updated_at, now)}
              </span>
            </time>
          </Tooltip>
        ) : (
          <span aria-label="Update time unknown">—</span>
        )}
      </span>
      {!simple && (
        <span className="ticket-row-update">
          {update?.editing_agent ? (
            <>
              <HarnessMark
                harness={update.editing_agent}
                name={update.editing_agent}
                decorative
              />
              <span>{update.editing_agent}:</span>
              <span className="ticket-row-update-brief">
                {progressBrief(update.brief.text)}
                {update.brief.truncated ? "…" : ""}
              </span>
            </>
          ) : (
            contextLabel
          )}
        </span>
      )}
    </>
  );
}

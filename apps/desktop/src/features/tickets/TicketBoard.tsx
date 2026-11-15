import { useEffect, useRef, useState } from "react";
import {
  ChevronsLeftRight,
  CornerDownRight,
  Folder,
  Layers,
  Loader2,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import { IconButton } from "@/components/ui/icon-button";
import { Pager } from "@/components/ui/pager";
import { Reference } from "@/components/ui/reference";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStatusLine } from "@/components/ui/use-status-line";
import { emptyCopy } from "@/lib/empty-copy";
import { ticketStatuses } from "@/lib/statuses";
import type { Ticket } from "@/lib/api/client";
import { useConflicts } from "@/features/sync-review/use-conflicts";
import { ConfirmLeaveDuplicate } from "./ConfirmLeaveDuplicate";
import { Duplicates } from "./Duplicates";
import { RowTags } from "./RowTags";
import { StatusIcon } from "./StatusIcon";
import { SourcePill } from "./TicketList";
import {
  readiness,
  readinessLabel,
  rowContextItem,
  type RowContextKind,
} from "./ticket-row";
import { externalSource, ticketStatusChoices } from "./ticket-source";
import type { TicketWorkspace } from "./useTicketWorkspace";
import { useBoardDrag } from "./useBoardDrag";
import "./ticket-board.css";

/** Cards the board reads per column at a time (useTicketBoard). */
const BOARD_PAGE = 50;
/** Terminal statuses fold to a 40px header until someone opens them. */
const FOLDED_BY_DEFAULT = new Set(["Canceled", "Duplicate"]);

/**
 * The status board (DESIGN.md section 6, S5). Columns share the width
 * between 220 and 320px; Canceled and Duplicate fold to 40px headers, so the
 * whole workflow fits at 1280px. A drop or a status choice moves the card at
 * once with "Saving…" and a dashed slot where it was; the outcome is said in
 * the pane's status line with Undo, and a failure puts the card back with the
 * reason on it. Nothing is inserted above the columns.
 */
export function TicketBoard({
  workspace,
  onOpen,
  onAdd,
  empty,
}: {
  workspace: TicketWorkspace;
  onOpen: (reference: string) => void;
  /**
   * The view's empty state, when nothing matches at all: drawn once in place
   * of six empty columns (BD-06).
   */
  empty?: React.ReactNode;
  /** Starts a ticket in a status; absent where nothing can be added. */
  onAdd?: ((status: string, trigger: HTMLButtonElement) => void) | undefined;
}) {
  const { statusAction } = workspace;
  // Columns are the statuses, so only the other filters can empty one.
  const narrowed = Boolean(
    workspace.query ||
    workspace.tags ||
    workspace.family ||
    workspace.plan !== workspace.navigation.plan ||
    workspace.availability,
  );
  const { board: boardRef, drag, start, open } = useBoardDrag(workspace);
  const statusLine = useStatusLine();
  const { notice, noticeUndo, dismissNotice } = statusAction;
  useEffect(() => {
    if (!notice) return;
    statusLine.show({
      message: notice,
      ...(noticeUndo && { undo: noticeUndo }),
    });
    dismissNotice();
  }, [notice, noticeUndo, dismissNotice, statusLine]);
  const { conflicts } = useConflicts();
  const needsReview = new Set(
    conflicts.filter((item) => item.kind === "ticket").map((item) => item.id),
  );
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  // A card the person moves into a folded column opens that column, so the
  // card (and focus on its status trigger) never disappears into it.
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const moving = [
    ...statusAction.pending,
    ...(statusAction.review ? [statusAction.review.ticket.reference] : []),
  ].filter((reference) => !moved.has(reference));
  if (moving.length > 0) setMoved(new Set([...moved, ...moving]));
  const landed = workspace.board.columns.filter(
    (column) =>
      FOLDED_BY_DEFAULT.has(column.status) &&
      !unfolded.has(column.status) &&
      column.tickets.some((ticket) => moved.has(ticket.reference)),
  );
  if (landed.length > 0) {
    const arrived = new Set(
      landed.flatMap((column) => column.tickets.map((t) => t.reference)),
    );
    setMoved(new Set([...moved].filter((r) => !arrived.has(r))));
    setUnfolded(new Set([...unfolded, ...landed.map((c) => c.status)]));
  }
  // "Show 50 more": the next cards land where the button was. For a moment a
  // click there is ignored, and keyboard focus moves to the first new card,
  // so a double click never opens a card that slid under the pointer (BD-09).
  const arriving = useRef<{
    status: string;
    from: number;
    focused: boolean;
  } | null>(null);
  const guardUntil = useRef(0);
  const lengths = workspace.board.columns.map(
    (column) => column.tickets.length,
  );
  const lengthKey = lengths.join(",");
  useEffect(() => {
    const pending = arriving.current;
    if (!pending) return;
    const column = workspace.board.columns.find(
      (item) => item.status === pending.status,
    );
    if (!column || column.loading || column.tickets.length <= pending.from)
      return;
    arriving.current = null;
    guardUntil.current = Date.now() + 400;
    const first = column.tickets[pending.from];
    if (pending.focused && first)
      boardRef.current
        ?.querySelector<HTMLElement>(
          `[data-board-reference="${first.reference}"]`,
        )
        ?.focus();
  }, [lengthKey, workspace.board.columns, boardRef]);
  const scope = {
    showPlan: !workspace.navigation.plan,
    showProject: workspace.navigation.project === "all",
    plans: workspace.plans,
    projects: workspace.projects,
  };
  return (
    <>
      {statusAction.review?.status === "Duplicate" && (
        <Duplicates
          ticket={statusAction.review.ticket}
          open
          title={`Mark ${statusAction.review.ticket.reference} as a duplicate`}
          description={`${statusAction.review.ticket.reference} keeps its description and history and becomes Duplicate. Review what points at it.`}
          refresh={statusAction.completeDuplicate}
          onApplyFailure={statusAction.reconcileDuplicate}
          onOpenChange={(open) => {
            if (!open) statusAction.cancelReview();
          }}
          returnFocus={statusAction.returnFocus}
        />
      )}
      <ConfirmLeaveDuplicate
        canonical={statusAction.review?.ticket.duplicate_of ?? ""}
        status={
          statusAction.review?.status !== "Duplicate"
            ? (statusAction.review?.status ?? null)
            : null
        }
        returnFocus={statusAction.returnFocus}
        onCancel={statusAction.cancelReview}
        onConfirm={statusAction.confirmLeave}
      />
      {empty && <div className="ticket-scroll">{empty}</div>}
      <div
        ref={boardRef}
        hidden={Boolean(empty)}
        className="ticket-board"
        role="region"
        aria-label="Ticket status board"
        tabIndex={-1}
      >
        {workspace.board.columns.map((column) => {
          const { status, tickets: items, total, loading, error } = column;
          const allowed = drag
            ? ticketStatusChoices(drag.ticket).includes(status) &&
              status !== drag.ticket.status
            : undefined;
          const folded =
            FOLDED_BY_DEFAULT.has(status) &&
            !unfolded.has(status) &&
            drag?.target !== status;
          const columnProps = {
            "data-board-status": status,
            "data-drop-allowed": allowed,
            "data-drop-target": drag?.target === status || undefined,
            "aria-label": `${status} column`,
          };
          if (folded)
            return (
              <section
                key={status}
                className="board-column"
                data-folded=""
                {...columnProps}
              >
                <Tooltip content={`Show ${status}`} side="bottom">
                  <button
                    type="button"
                    className="board-column-fold"
                    aria-label={`Show ${status}, ${total ?? "unknown"} ${total === 1 ? "ticket" : "tickets"}`}
                    aria-expanded={false}
                    onClick={() =>
                      setUnfolded((old) => new Set(old).add(status))
                    }
                  >
                    <StatusIcon status={status} decorative />
                    <span className="board-column-fold-label">{status}</span>
                    <Count>{total ?? "…"}</Count>
                  </button>
                </Tooltip>
              </section>
            );
          // A move's old place: a dashed slot until the core confirms it.
          const slots = [...statusAction.moves.entries()].filter(
            ([, move]) => move.status === status,
          );
          const cards = items.map((ticket) => (
            <BoardCard
              key={ticket.id}
              ticket={ticket}
              workspace={workspace}
              scope={scope}
              selected={workspace.selected === ticket.reference}
              dragging={drag?.ticket.reference === ticket.reference}
              needsReview={needsReview.has(ticket.id)}
              onPointerDown={(event) => start(event, ticket)}
              onClick={(event) => {
                if (Date.now() < guardUntil.current) return;
                if (open(event.currentTarget, event.detail))
                  onOpen(ticket.reference);
              }}
            />
          ));
          for (const [reference, move] of slots.sort(
            ([, a], [, b]) => b.index - a.index,
          ))
            cards.splice(
              Math.min(move.index, cards.length),
              0,
              <div
                key={`slot-${reference}`}
                className="board-card-slot"
                aria-hidden="true"
              />,
            );
          return (
            <section key={status} className="board-column" {...columnProps}>
              <header className="board-column-header">
                <StatusIcon status={status} />
                <h2>{status}</h2>
                <span aria-label={`${total ?? "Unknown"} matching tickets`}>
                  {total ?? "…"}
                </span>
                {allowed === false && (
                  // Said where the card is, while dragging over refusal.
                  <span className="board-column-refused">Can’t move here</span>
                )}
                <span className="board-column-actions">
                  {onAdd && status !== "Duplicate" && (
                    <IconButton
                      label={`Add ${status} ticket`}
                      onClick={(event) => onAdd(status, event.currentTarget)}
                    >
                      <Plus />
                    </IconButton>
                  )}
                  {FOLDED_BY_DEFAULT.has(status) && (
                    <IconButton
                      label={`Fold ${status}`}
                      onClick={() =>
                        setUnfolded((old) => {
                          const next = new Set(old);
                          next.delete(status);
                          return next;
                        })
                      }
                    >
                      <ChevronsLeftRight />
                    </IconButton>
                  )}
                </span>
              </header>
              <div className="board-column-body" aria-busy={loading}>
                {error && (
                  <div className="board-read-error" role="status">
                    <span>
                      {total === null
                        ? `Couldn't load ${status} tickets.`
                        : "Can’t refresh. Showing the saved tickets."}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void workspace.board.refresh()}
                    >
                      Retry
                    </Button>
                  </div>
                )}
                {cards}
                {loading && total === null && (
                  <p className="board-column-note" role="status">
                    Loading tickets…
                  </p>
                )}
                {!loading && !error && items.length === 0 && (
                  // One muted line; the header holds Add (BD-06).
                  <p className="board-column-note">
                    {
                      emptyCopy(
                        narrowed ? "board-column-filtered" : "board-column",
                      ).title
                    }
                  </p>
                )}
                {total !== null && items.length < total && (
                  <Pager
                    more={Math.min(BOARD_PAGE, total - items.length)}
                    noun={status}
                    loading={loading}
                    onMore={() => {
                      arriving.current = {
                        status,
                        from: items.length,
                        focused:
                          document.activeElement?.closest(
                            '[data-slot="pager"]',
                          ) != null,
                      };
                      void workspace.board.loadMore(status);
                    }}
                  />
                )}
              </div>
            </section>
          );
        })}
      </div>
      {drag && (
        <>
          <div
            className="board-drag-preview"
            aria-hidden="true"
            style={{
              left: drag.x - drag.offsetX,
              top: drag.y - drag.offsetY,
              width: drag.width,
            }}
          >
            <Reference>{drag.ticket.reference}</Reference>
            <span className="board-card-title">{drag.ticket.title}</span>
          </div>
          <p className="sr-only" role="status">
            {drag.target
              ? `Drop to change status to ${drag.target}.`
              : "Drag to an allowed status column. Escape cancels."}
          </p>
        </>
      )}
      {/* Only while something narrows the columns (BD-04). */}
      {narrowed && (
        <p className="board-summary">Counts reflect current filters.</p>
      )}
    </>
  );
}

function ContextIcon({ kind }: { kind: RowContextKind }) {
  if (kind === "duplicate")
    return <StatusIcon status="Duplicate" size={12} decorative />;
  if (kind === "subticket") return <CornerDownRight aria-hidden="true" />;
  return kind === "plan" ? (
    <Layers aria-hidden="true" />
  ) : (
    <Folder aria-hidden="true" />
  );
}

/**
 * One card: [status icon] Reference · source pill, the title in up to three
 * lines, then the row's line two (Blocked, one context item, tags). The
 * status trigger appears on hover or focus; pending and failure live on the
 * card itself.
 */
function BoardCard({
  ticket,
  workspace,
  scope,
  selected,
  dragging,
  needsReview,
  onPointerDown,
  onClick,
}: {
  ticket: Ticket;
  workspace: TicketWorkspace;
  scope: Parameters<typeof rowContextItem>[1];
  selected: boolean;
  dragging: boolean;
  needsReview: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { statusAction } = workspace;
  const source = externalSource(ticket);
  const state = readiness(ticket);
  const context = rowContextItem(ticket, scope);
  const pending = statusAction.pending.has(ticket.reference);
  const failure = statusAction.failures[ticket.reference];
  return (
    <div
      className="board-card-container"
      data-dragging={dragging || undefined}
      aria-busy={pending}
    >
      <Button
        variant="ghost"
        className="board-card"
        data-board-reference={ticket.reference}
        aria-pressed={selected}
        onPointerDown={onPointerDown}
        onDragStart={(event) => event.preventDefault()}
        onClick={onClick}
      >
        <span className="board-card-top">
          <StatusIcon status={ticket.status} size={14} decorative />
          <Reference>{ticket.reference}</Reference>{" "}
          <span className="sr-only">{ticket.status}</span>{" "}
          <SourcePill ticket={ticket} />
          {pending && (
            <span className="board-card-pending" role="status">
              <Loader2 aria-hidden="true" className="animate-spin" />
              Saving…
            </span>
          )}
        </span>{" "}
        <Tooltip content={ticket.title} overflowOnly>
          <span className="board-card-title">{ticket.title}</span>
        </Tooltip>
        <span className="board-card-meta">
          {needsReview ? (
            <span className="board-card-state">
              <StatusDot tone="attention" size={10} />
              Needs review
            </span>
          ) : source?.unavailable ? (
            <span className="board-card-state">
              <StatusDot tone="attention" size={10} />
              Source unavailable
            </span>
          ) : (
            // Ready is the column's norm; only Blocked is news (list R-10).
            state.kind === "blocked" && (
              <span className="board-card-state">
                <StatusDot tone="blocked" size={10} />
                {readinessLabel(state)}
              </span>
            )
          )}
          {context && (
            <span className="board-card-context">
              <ContextIcon kind={context.kind} />
              <span>{context.label}</span>
            </span>
          )}
          <RowTags tags={ticket.tags} />
        </span>
      </Button>
      <span className="board-card-status">
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={ticket.trashed || pending}>
            <IconButton
              variant="outline"
              data-board-status-reference={ticket.reference}
              label={`Change status of ${ticket.reference}, current status: ${ticket.status}`}
              tooltipSide="top"
              disabled={ticket.trashed || pending}
            >
              <StatusIcon status={ticket.status} size={14} decorative />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            aria-label={`Change status of ${ticket.reference}`}
          >
            <DropdownMenuLabel>Status</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={ticket.status}
              onValueChange={(status) =>
                void statusAction.choose(ticket, status)
              }
            >
              {ticketStatuses.map((choice) => (
                <DropdownMenuRadioItem
                  key={choice}
                  value={choice}
                  disabled={
                    choice !== ticket.status &&
                    !ticketStatusChoices(ticket).includes(choice)
                  }
                >
                  <StatusIcon status={choice} decorative />
                  {choice}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {source && (
              <p className="status-menu-caption">
                Status choices follow {source.provider_name}.
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {failure && (
        // The reason stays on the card that failed, with Retry (BD-10).
        <div className="board-card-failure" role="alert">
          <span>{failure}</span>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Retry status change for ${ticket.reference}`}
            onClick={() => statusAction.retry(ticket.reference)}
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

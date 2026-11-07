import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import {
  CornerDownRight,
  Folder,
  Layers,
  MoreHorizontal,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ticketStatuses } from "@/lib/statuses";
import { Duplicates } from "./Duplicates";
import { ConfirmLeaveDuplicate } from "./ConfirmLeaveDuplicate";
import { SourcePill } from "./TicketList";
import { StatusIcon } from "./StatusIcon";
import { readiness, readinessLabel } from "./ticket-row";
import { externalSource, ticketStatusChoices } from "./ticket-source";
import type { TicketWorkspace } from "./useTicketWorkspace";
import { useBoardDrag } from "./useBoardDrag";
import "./ticket-board.css";
import { Reference } from "@/components/ui/reference";

export function TicketBoard({
  workspace,
  onOpen,
}: {
  workspace: TicketWorkspace;
  onOpen: (reference: string) => void;
}) {
  const { statusAction } = workspace;
  const { board: boardRef, drag, start, open } = useBoardDrag(workspace);
  return (
    <>
      <div
        className={statusAction.notice ? "board-status-notice" : "sr-only"}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span>{statusAction.notice}</span>
        {statusAction.notice && (
          <IconButton
            label="Dismiss status update"
            onClick={() => {
              statusAction.dismissNotice();
              boardRef.current?.focus({ preventScroll: true });
            }}
          >
            <X />
          </IconButton>
        )}
      </div>
      {Object.entries(statusAction.failures)
        .filter(([, message]) => message)
        .map(([reference, message]) => (
          <p key={reference} className="board-status-error" role="alert">
            {message}{" "}
            <Button
              variant="link"
              size="sm"
              onClick={() => statusAction.retry(reference)}
            >
              Retry status change for {reference}
            </Button>
          </p>
        ))}
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
      <div
        ref={boardRef}
        className="ticket-board"
        role="region"
        aria-label="Ticket status board"
        tabIndex={-1}
      >
        {workspace.board.columns.map((column) => {
          const { status, tickets: items, total, loading, error } = column;
          return (
            <section
              className="board-column"
              data-board-status={status}
              data-drop-allowed={
                drag
                  ? ticketStatusChoices(drag.ticket).includes(status) &&
                    status !== drag.ticket.status
                  : undefined
              }
              data-drop-target={drag?.target === status || undefined}
              key={status}
              aria-label={`${status} column`}
            >
              <header className="board-column-header">
                <StatusIcon status={status} />
                <h2>{status}</h2>
                <span aria-label={`${total ?? "Unknown"} matching tickets`}>
                  {total ?? "…"}
                </span>
              </header>
              <div className="board-column-body" aria-busy={loading}>
                {error && (
                  <p className="board-read-error" role="status">
                    {total === null
                      ? "Could not load tickets."
                      : "Can’t refresh. Showing saved tickets; information may be stale."}{" "}
                    <Button
                      variant="link"
                      size="sm"
                      title={error}
                      onClick={() => void workspace.board.refresh()}
                    >
                      Retry
                    </Button>
                  </p>
                )}
                {items.map((ticket) => {
                  const source = externalSource(ticket);
                  const state = readiness(ticket);
                  const project =
                    workspace.navigation.project === "all" &&
                    workspace.projects.find((p) => p.id === ticket.project_id);
                  const plan =
                    !workspace.navigation.plan &&
                    workspace.plans.find((p) => p.id === ticket.plan_id);
                  return (
                    <div
                      className="board-card-container"
                      data-dragging={
                        drag?.ticket.reference === ticket.reference || undefined
                      }
                      key={ticket.id}
                      aria-busy={statusAction.pending.has(ticket.reference)}
                    >
                      <Button
                        variant="ghost"
                        className="board-card"
                        data-board-reference={ticket.reference}
                        aria-pressed={workspace.selected === ticket.reference}
                        onPointerDown={(event) => start(event, ticket)}
                        onDragStart={(event) => event.preventDefault()}
                        onClick={(event) => {
                          if (open(event.currentTarget, event.detail))
                            onOpen(ticket.reference);
                        }}
                      >
                        <span className="board-card-top">
                          <Reference>{ticket.reference}</Reference>
                          <SourcePill ticket={ticket} />
                        </span>
                        <span className="board-card-title" title={ticket.title}>
                          {ticket.title}
                        </span>
                        {source?.unavailable ? (
                          <span className="board-card-state">
                            <StatusDot tone="attention" size={10} />
                            Source unavailable
                          </span>
                        ) : (
                          state.kind !== "status" && (
                            <span className="board-card-state">
                              <StatusDot tone={state.kind} size={10} />
                              {readinessLabel(state)}
                            </span>
                          )
                        )}
                        {(project || plan || ticket.parent) && (
                          <span className="board-card-context">
                            {project && (
                              <span>
                                <Folder aria-hidden="true" />
                                {project.name}
                              </span>
                            )}
                            {plan && (
                              <span>
                                <Layers aria-hidden="true" />
                                {plan.name}
                              </span>
                            )}
                            {ticket.parent && (
                              <span>
                                <CornerDownRight aria-hidden="true" />
                                Subticket of {ticket.parent.reference}
                              </span>
                            )}
                          </span>
                        )}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="board-card-menu"
                            aria-label={`Change status of ${ticket.reference}`}
                            title={`Change status (saved: ${ticket.status})`}
                            disabled={
                              ticket.trashed ||
                              statusAction.pending.has(ticket.reference)
                            }
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          aria-label={`Change status of ${ticket.reference}`}
                        >
                          <DropdownMenuLabel>
                            Saved status: {ticket.status}
                          </DropdownMenuLabel>
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
                      {statusAction.pending.has(ticket.reference) && (
                        <span className="board-card-saving" role="status">
                          Saving {ticket.reference}…
                        </span>
                      )}
                    </div>
                  );
                })}
                {loading && total === null && (
                  <p className="board-empty">Loading tickets…</p>
                )}
                {!loading && !error && items.length === 0 && (
                  <p className="board-empty">No matching tickets</p>
                )}
                {total !== null && items.length < total && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={loading}
                      onClick={() => void workspace.board.loadMore(status)}
                      aria-label={`Load more ${status}`}
                    >
                      Load more
                    </Button>
                    <p className="board-loaded">
                      {items.length} of {total} loaded
                    </p>
                  </>
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
      <p className="board-summary">Counts reflect current filters.</p>
    </>
  );
}

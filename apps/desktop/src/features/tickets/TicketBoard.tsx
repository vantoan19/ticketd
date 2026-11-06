import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { CornerDownRight, Folder, Layers } from "lucide-react";
import { SourcePill } from "./TicketList";
import { StatusIcon } from "./StatusIcon";
import { readiness, readinessLabel } from "./ticket-row";
import { externalSource } from "./ticket-source";
import type { TicketWorkspace } from "./useTicketWorkspace";
import "./ticket-board.css";

export function TicketBoard({
  workspace,
  onOpen,
}: {
  workspace: TicketWorkspace;
  onOpen: (reference: string) => void;
}) {
  return (
    <>
      <div
        className="ticket-board"
        role="region"
        aria-label="Ticket status board"
      >
        {workspace.board.columns.map((column) => {
          const { status, tickets: items, total, loading, error } = column;
          return (
            <section
              className="board-column"
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
                    <Button
                      variant="ghost"
                      className="board-card"
                      key={ticket.id}
                      data-board-reference={ticket.reference}
                      aria-pressed={workspace.selected === ticket.reference}
                      onClick={() => onOpen(ticket.reference)}
                    >
                      <span className="board-card-top">
                        <span className="ticket-ref">{ticket.reference}</span>
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
      <p className="board-summary">Counts reflect current filters.</p>
    </>
  );
}

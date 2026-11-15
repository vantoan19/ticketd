import { StatusLineRegion } from "@/components/ui/status-line";
import { TicketDetails } from "@/features/tickets/TicketDetails";
import type { MentionTarget } from "@/features/tickets/Backlinks";
import type { TicketWorkspace } from "@/features/tickets/useTicketWorkspace";

/**
 * The selected ticket's detail, with a note when it is outside the results,
 * and the detail pane's own status line.
 */
export function TicketDetailPane({
  workspace,
  expanded,
  inboxTarget,
  onExpand,
  onReturn,
  onSelect,
  context = "list",
}: {
  workspace: TicketWorkspace;
  /** Opened from the Inbox: no list position, no "outside the results". */
  context?: "list" | "inbox";
  expanded: boolean;
  inboxTarget: { reference: string; id: string; key: number } | null;
  onExpand: () => void;
  onReturn: () => void;
  onSelect: (reference: string | null, mention?: MentionTarget) => void;
}) {
  const {
    selected,
    mention,
    loading,
    queryError,
    tickets,
    details,
    projects,
    plans,
    revision,
    refresh,
    updateTicket,
    position,
    openAdjacent,
  } = workspace;
  const resultTickets =
    workspace.layout === "board"
      ? workspace.board.columns.flatMap((column) => column.tickets)
      : tickets;
  const resultLoading =
    workspace.layout === "board"
      ? workspace.board.columns.some((column) => column.loading)
      : loading;
  return (
    <StatusLineRegion>
      <TicketDetails
        outsideResults={Boolean(
          context === "list" &&
          selected &&
          !resultLoading &&
          !queryError &&
          !resultTickets.some((ticket) => ticket.reference === selected),
        )}
        expanded={expanded}
        onExpand={onExpand}
        onReturn={onReturn}
        selected={selected}
        mention={mention}
        inboxTarget={inboxTarget}
        setSelected={onSelect}
        details={details}
        projects={projects}
        plans={plans}
        revision={revision}
        refresh={refresh}
        updateTicket={updateTicket}
        position={
          workspace.layout === "board" || context === "inbox" ? null : position
        }
        onAdjacent={openAdjacent}
        failure={workspace.detailFailure}
        onRetry={workspace.retryDetail}
        returnLabel={context === "inbox" ? "Inbox" : workspace.scopeName}
      />
    </StatusLineRegion>
  );
}

import { TicketDetails } from "@/features/tickets/TicketDetails";
import type { TicketWorkspace } from "@/features/tickets/useTicketWorkspace";

/** The selected ticket's detail, with a note when it is outside the results. */
export function TicketDetailPane({
  workspace,
  expanded,
  inboxTarget,
  onExpand,
  onReturn,
  onSelect,
}: {
  workspace: TicketWorkspace;
  expanded: boolean;
  inboxTarget: { reference: string; id: string; key: number } | null;
  onExpand: () => void;
  onReturn: () => void;
  onSelect: (reference: string | null) => void;
}) {
  const {
    selected,
    loading,
    queryError,
    tickets,
    details,
    projects,
    efforts,
    revision,
    refresh,
    updateTicket,
  } = workspace;
  return (
    <>
      {selected &&
        !loading &&
        !queryError &&
        !tickets.some((ticket) => ticket.reference === selected) && (
          <p className="selection-context" role="status">
            This ticket is outside the current results.
          </p>
        )}
      <TicketDetails
        expanded={expanded}
        onExpand={onExpand}
        onReturn={onReturn}
        selected={selected}
        inboxTarget={inboxTarget}
        setSelected={onSelect}
        details={details}
        projects={projects}
        efforts={efforts}
        revision={revision}
        refresh={refresh}
        updateTicket={updateTicket}
      />
    </>
  );
}

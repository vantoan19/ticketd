import { PlanDependencies } from "@/features/plans/PlanDependencies";
import { TicketDetails } from "@/features/tickets/TicketDetails";
import type { MentionTarget } from "@/features/tickets/Backlinks";
import type { TicketWorkspace } from "@/features/tickets/useTicketWorkspace";

/** The selected ticket's detail, with a note when it is outside the results. */
export function TicketDetailPane({
  workspace,
  expanded,
  planMode,
  closePlanMode,
  inboxTarget,
  onExpand,
  onReturn,
  onSelect,
}: {
  workspace: TicketWorkspace;
  expanded: boolean;
  planMode: "list" | "dependencies";
  closePlanMode: () => void;
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
  const planScope = workspace.trash ? "" : workspace.navigation.plan;
  if (planMode === "dependencies" && planScope)
    return (
      <PlanDependencies
        id={planScope}
        revision={revision}
        projects={projects}
        refresh={refresh}
        onClose={closePlanMode}
        onOpen={(reference) => {
          closePlanMode();
          onSelect(reference);
        }}
      />
    );
  return (
    <>
      <TicketDetails
        outsideResults={Boolean(
          selected &&
          !loading &&
          !queryError &&
          !tickets.some((ticket) => ticket.reference === selected),
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
        position={position}
        onAdjacent={openAdjacent}
      />
    </>
  );
}

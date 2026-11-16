import { useInboxTriage } from "./inbox-triage-context";
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
  hidden = false,
  expanded,
  inboxTarget,
  onExpand,
  onReturn,
  onSelect,
  context = "list",
}: {
  workspace: TicketWorkspace;
  hidden?: boolean;
  /** Opened from the Inbox: no list position, no "outside the results". */
  context?: "list" | "inbox";
  expanded: boolean;
  inboxTarget: { reference: string; id: string; key: number } | null;
  onExpand: () => void;
  onReturn: () => void;
  onSelect: (reference: string | null, mention?: MentionTarget) => void;
}) {
  const triage = useInboxTriage();
  const {
    selected,
    mention,
    loading,
    queryError,
    tickets,
    opened,
    projects,
    plans,
    revision,
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
        hidden={hidden}
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
        opened={opened}
        onMentionReady={workspace.markMentionReady}
        onClearMention={workspace.clearMention}
        preview={resultTickets.find((ticket) => ticket.reference === selected)}
        projects={projects}
        plans={plans}
        revision={revision}
        position={
          context === "inbox"
            ? (triage?.position ?? null)
            : workspace.layout === "board"
              ? null
              : position
        }
        onAdjacent={
          context === "inbox"
            ? (triage?.adjacent ?? openAdjacent)
            : openAdjacent
        }
        returnLabel={context === "inbox" ? "Inbox" : workspace.scopeName}
      />
    </StatusLineRegion>
  );
}

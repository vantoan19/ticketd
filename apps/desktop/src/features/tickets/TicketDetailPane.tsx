import { useInboxTriage } from "./inbox-triage-context";
import { useHeld } from "./use-pane-motion";
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
  expanded: expandedNow,
  inboxTarget,
  onExpand,
  onReturn,
  onSelect,
  context = "list",
  overview,
  leaving = false,
}: {
  workspace: TicketWorkspace;
  hidden?: boolean;
  /**
   * The ticket was just closed and the pane is fading out. It keeps showing
   * that ticket, as it was, instead of the empty state it would become.
   */
  leaving?: boolean;
  /** Opened from the Inbox: no list position, no "outside the results". */
  context?: "list" | "inbox";
  overview?: {
    position: TicketWorkspace["position"];
    onAdjacent: (direction: 1 | -1) => void;
    loaded: boolean;
  };
  expanded: boolean;
  inboxTarget: { reference: string; id: string; key: number } | null;
  onExpand: () => void;
  onReturn: () => void;
  onSelect: (reference: string | null, mention?: MentionTarget) => void;
}) {
  const triage = useInboxTriage();
  const {
    mention,
    loading,
    queryError,
    tickets,
    opened,
    projects,
    plans,
    openAdjacent,
  } = workspace;
  // `expanded` is held with the ticket: closing from full width clears it at
  // once, and the document would re-lay out at the split's width as it fades.
  const { selected, position, expanded } = useHeld(
    {
      expanded: expandedNow,
      selected: workspace.selected,
      position:
        context === "inbox"
          ? (triage?.position ?? null)
          : overview
            ? overview.position
            : workspace.layout === "board"
              ? null
              : workspace.position,
    },
    leaving,
  );
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
          (overview
            ? overview.loaded && !position
            : !resultLoading &&
              !queryError &&
              !resultTickets.some((ticket) => ticket.reference === selected)),
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
        position={position}
        leaving={leaving}
        onAdjacent={
          context === "inbox"
            ? (triage?.adjacent ?? openAdjacent)
            : (overview?.onAdjacent ?? openAdjacent)
        }
        returnLabel={context === "inbox" ? "Inbox" : workspace.scopeName}
      />
    </StatusLineRegion>
  );
}

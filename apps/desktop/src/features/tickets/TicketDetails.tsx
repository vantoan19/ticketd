import { EmptyState } from "@/components/ui/empty-state";
import { FailureState } from "@/components/ui/failure-alert";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { Kbd } from "@/components/ui/kbd";
import { TicketHeader } from "@/features/tickets/TicketHeader";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { type Project, type Ticket } from "@/lib/api/client";
import type { MentionTarget } from "@/features/tickets/Backlinks";
import type { FollowedMention } from "@/features/tickets/useTicketWorkspace";
import type { Plan } from "@/lib/api/plans";
import { TicketPage } from "@/features/tickets/TicketPage";
import { useNarrowPane } from "@/features/tickets/useNarrowPane";
type NoteTarget = { id: string; key: number };

/** Two ways to arrive at a note (the Inbox, a backlink); the later one wins. */
function newest(
  first: NoteTarget | null,
  second: NoteTarget | null,
): NoteTarget | null {
  if (first && second) return second.key >= first.key ? second : first;
  return first ?? second;
}

const DependencyGraph = lazy(
  () => import("@/features/tickets/DependencyGraph"),
);
export function TicketDetails({
  selected,
  mention,
  inboxTarget,
  expanded,
  onExpand,
  onReturn,
  setSelected,
  details,
  projects,
  plans,
  revision,
  refresh,
  updateTicket,
  position = null,
  onAdjacent,
  returnLabel,
  outsideResults = false,
  failure = null,
  onRetry,
}: {
  outsideResults?: boolean;
  /** Why the selected ticket could not be fetched; shown in place of it. */
  failure?: FailureDescription | null;
  onRetry?: () => void;
  /** The selected ticket's place in the visible list, across pages. */
  position?: { index: number; total: number } | null;
  /** The list's name, for the expanded view's return crumb. */
  returnLabel?: string;
  /** Open the ticket before (-1) or after (1) the selected one in the list. */
  onAdjacent?: (direction: 1 | -1) => void;
  selected: string | null;
  /** The mention being followed, if any; the workspace clears it on navigation. */
  mention: FollowedMention | null;
  inboxTarget?: { reference: string; id: string; key: number } | null;
  expanded: boolean;
  onExpand: () => void;
  onReturn: () => void;
  setSelected: (value: string | null, mention?: MentionTarget) => void;
  details: Record<string, Ticket>;
  projects: Project[];
  plans: Plan[];
  revision: number;
  refresh: () => Promise<void>;
  updateTicket: (ticket: Ticket) => void;
}) {
  // Relationship links unmount their focused control. Keep keyboard navigation
  // on the selected reference without stealing focus from Previous/Next.
  useEffect(() => {
    if (
      selected &&
      (document.activeElement === document.body ||
        document.activeElement?.id === "detail-heading")
    ) {
      document.getElementById("detail-heading")?.focus();
    }
  }, [selected]);
  const pane = useRef<HTMLElement>(null);
  const narrow = useNarrowPane(pane);
  const [graphReference, setGraphReference] = useState<string | null>(null);
  // The graph belongs to the ticket it opened from; selecting another closes it.
  const graphOpen = graphReference !== null && graphReference === selected;
  // Closing the graph unmounts the control that had focus; land on the ticket heading.
  const returnFromGraph = useRef(false);
  useEffect(() => {
    if (!graphOpen && returnFromGraph.current) {
      returnFromGraph.current = false;
      document.getElementById("detail-heading")?.focus();
    }
  }, [graphOpen]);
  const closeGraph = () => {
    returnFromGraph.current = true;
    setGraphReference(null);
  };
  // Plain selection: it ends any mention being followed.
  const open = (reference: string | null) => setSelected(reference);
  const ticket = Object.values(details).find(
    (item) => item.reference === selected,
  );
  return (
    <section
      ref={pane}
      className="ticket-detail"
      data-expanded={expanded || undefined}
      data-graph={graphOpen || undefined}
      data-empty={selected === null || undefined}
      aria-labelledby="detail-heading"
    >
      {graphOpen && selected && (
        <Suspense
          fallback={
            <p role="status" className="graph-loading">
              Loading graph…
            </p>
          }
        >
          <DependencyGraph
            key={selected}
            reference={selected}
            revision={revision}
            projects={projects}
            plans={plans}
            onBack={closeGraph}
            onOpen={(reference) => {
              closeGraph();
              open(reference);
            }}
          />
        </Suspense>
      )}
      <TicketHeader
        selected={selected}
        ticket={ticket}
        expanded={expanded}
        onExpand={onExpand}
        onReturn={onReturn}
        onClose={() => open(null)}
        onOpenGraph={() => setGraphReference(selected)}
        refresh={refresh}
        updateTicket={updateTicket}
        position={position}
        projects={projects}
        {...(returnLabel && { returnLabel })}
        {...(onAdjacent && { onAdjacent })}
      />
      <div className="detail-scroll">
        {outsideResults && (
          <p className="selection-context" role="status">
            This ticket is outside the current results.
          </p>
        )}
        {selected === null && (
          <EmptyState
            size="hint"
            title="Select a ticket to read it here"
            footnote={
              <>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> move <Kbd>Enter</Kbd> open
              </>
            }
          />
        )}
        {selected !== null && !ticket && failure && (
          <FailureState failure={failure} {...(onRetry && { onRetry })} />
        )}
        {Object.values(details).map((item) => (
          <TicketPage
            key={item.id}
            ticket={item}
            active={item.reference === selected}
            narrow={narrow}
            projects={projects}
            plans={plans}
            revision={revision}
            refresh={refresh}
            updateTicket={updateTicket}
            select={open}
            onOpenGraph={() => setGraphReference(item.reference)}
            noteTarget={newest(
              inboxTarget?.reference === item.reference ? inboxTarget : null,
              mention?.reference === item.reference && mention.noteId
                ? { id: mention.noteId, key: mention.key }
                : null,
            )}
            mention={
              mention?.reference === item.reference &&
              !mention.noteId &&
              mention.ready
                ? mention
                : null
            }
            onMention={(target) => setSelected(target.reference, target)}
          />
        ))}
      </div>
    </section>
  );
}

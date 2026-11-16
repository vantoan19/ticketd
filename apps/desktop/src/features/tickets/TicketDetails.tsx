import { useInboxTriage } from "./inbox-triage-context";
import { InboxTriageCard } from "./InboxTriageCard";
import { TicketAgentSession } from "./TicketAgent";
import { OverlayBoundary } from "@/components/ui/overlay-boundary";
import { useCallback, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { TicketHeader } from "@/features/tickets/TicketHeader";
import { useContext, useEffect } from "react";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { type Project, type Ticket } from "@/lib/api/client";
import { OpenTicket, useTicket, useTicketChanged } from "./open-ticket";
import { useMentionReadiness } from "./use-mention-readiness";
import type { MentionTarget } from "@/features/tickets/Backlinks";
import type { FollowedMention } from "@/features/tickets/useTicketWorkspace";
import type { Plan } from "@/lib/api/plans";
import { TicketPage } from "@/features/tickets/TicketPage";
type NoteTarget = { id: string; key: number };

/** Two ways to arrive at a note (the Inbox, a backlink); the later one wins. */
function newest(
  first: NoteTarget | null,
  second: NoteTarget | null,
): NoteTarget | null {
  if (first && second) return second.key >= first.key ? second : first;
  return first ?? second;
}

export function TicketDetails({
  selected,
  hidden = false,
  mention,
  inboxTarget,
  expanded,
  onExpand,
  onReturn,
  setSelected,
  opened = [],
  onMentionReady,
  onClearMention,
  preview,
  projects,
  plans,
  revision,
  position = null,
  onAdjacent,
  returnLabel,
  outsideResults = false,
}: {
  outsideResults?: boolean;
  hidden?: boolean;
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
  /** The tickets opened so far, each kept as a page (hidden unless selected). */
  opened?: string[];
  /** The followed mention can be judged: the selected ticket's record is current. */
  onMentionReady: (reference: string) => void;
  /** The followed mention ends: the selected ticket moved to or from Trash. */
  onClearMention: () => void;
  /** A complete Ticket already read for the list, retained while its fresh read runs. */
  preview?: Ticket | undefined;
  projects: Project[];
  plans: Plan[];
  revision: number;
}) {
  // Sections report their writes here. Reporting a change makes the record and
  // the reads on screen current and refreshes the list (it follows the change).
  const changed = useTicketChanged();
  const refresh = useCallback(async () => {
    await changed();
  }, [changed]);
  const triage = useInboxTriage();
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
  const [boundary, setBoundary] = useState<HTMLElement | null>(null);
  const [scrolledReference, setScrolledReference] = useState<string | null>(
    null,
  );
  // A ticket's graph is the one graph view, opened on its dependencies.
  const openGraph = useContext(ContextGraphNavigation);
  const showGraph = (reference: string | null) => {
    if (reference) openGraph?.(reference, { dependencies: true });
  };
  // Plain selection: it ends any mention being followed.
  const open = (reference: string | null) => setSelected(reference);
  // The selected ticket's record, shared with its page; the header, the agent
  // session and the triage card sit above the pages and read it from here.
  const ticket = useTicket(selected).value ?? undefined;
  useMentionReadiness({
    selected,
    mention,
    onReady: onMentionReady,
    onEnd: onClearMention,
  });
  const pages =
    selected && !opened.includes(selected) ? [...opened, selected] : opened;
  return (
    <section
      ref={setBoundary}
      className="ticket-detail"
      hidden={hidden}
      data-expanded={expanded || undefined}
      data-empty={selected === null || undefined}
      aria-labelledby="detail-heading"
    >
      <OverlayBoundary element={boundary}>
        <TicketAgentSession ticket={ticket ?? preview} revision={revision}>
          {(agentLoading) => (
            <>
              <TicketHeader
                selected={selected}
                ticket={ticket}
                revision={revision}
                scrolled={selected !== null && scrolledReference === selected}
                expanded={expanded}
                onExpand={onExpand}
                onReturn={onReturn}
                onClose={() => open(null)}
                {...(openGraph && { onOpenGraph: () => showGraph(selected) })}
                refresh={refresh}
                position={position}
                projects={projects}
                {...(returnLabel && { returnLabel })}
                {...(onAdjacent && { onAdjacent })}
              />
              <div
                className="detail-scroll"
                onScroll={(event) => {
                  const scroller = event.currentTarget;
                  const title = scroller.querySelector<HTMLElement>(
                    ".detail-content:not([hidden]) .editor-title, .detail-content:not([hidden]) .detail-title",
                  );
                  const titleBottom = title
                    ? title.getBoundingClientRect().bottom -
                      scroller.getBoundingClientRect().top +
                      scroller.scrollTop
                    : 0;
                  setScrolledReference(
                    scroller.scrollTop > titleBottom ? selected : null,
                  );
                }}
              >
                {agentLoading && (
                  <span
                    className="sr-only"
                    role="status"
                    aria-label="Loading ticket agent context"
                  >
                    Loading agent context.
                  </span>
                )}
                <InboxTriageCard refresh={refresh} />
                {selected === null && !triage?.selection && (
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
                {pages.map((reference) => (
                  <OpenTicket
                    key={reference}
                    reference={reference}
                    seed={reference === selected ? preview : undefined}
                    hidden={hidden || reference !== selected}
                  >
                    <TicketPage
                      active={reference === selected}
                      outsideResults={outsideResults && reference === selected}
                      projects={projects}
                      plans={plans}
                      revision={revision}
                      refresh={refresh}
                      select={open}
                      onOpenGraph={() => showGraph(reference)}
                      noteTarget={newest(
                        inboxTarget?.reference === reference
                          ? inboxTarget
                          : null,
                        mention?.reference === reference && mention.noteId
                          ? { id: mention.noteId, key: mention.key }
                          : null,
                      )}
                      mention={
                        mention?.reference === reference &&
                        !mention.noteId &&
                        mention.ready
                          ? mention
                          : null
                      }
                      onMention={(target) =>
                        setSelected(target.reference, target)
                      }
                    />
                  </OpenTicket>
                ))}
              </div>
            </>
          )}
        </TicketAgentSession>
      </OverlayBoundary>
    </section>
  );
}

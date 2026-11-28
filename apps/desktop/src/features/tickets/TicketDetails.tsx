import { useInboxTriage } from "./inbox-triage-context";
import { InboxTriageCard } from "./InboxTriageCard";
import { TicketAgentSession } from "./TicketAgent";
import { OverlayBoundary } from "@/components/ui/overlay-boundary";
import { memo, useCallback, useRef, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { TicketHeader } from "@/features/tickets/TicketHeader";
import { useContext, useEffect } from "react";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { type Project, type Ticket } from "@/lib/api/client";
import { OpenTicket, useKnownTicket, useTicket } from "./open-ticket";
import { hasTicketDraft } from "./ticket-draft";
import { useDraftRecovery } from "@/lib/draft-recovery-context";
import { useMentionReadiness } from "./use-mention-readiness";
import type { MentionTarget } from "@/features/tickets/Backlinks";
import type {
  FollowedMention,
  TicketListPosition,
} from "@/features/tickets/useTicketWorkspace";
import type { Plan } from "@/lib/api/plans";
import { TicketPage } from "@/features/tickets/TicketPage";
import type { ReviewQueue } from "./TicketDecisionCard";
import { usePageSwap } from "./use-page-swap";
import { useNarrowPane } from "./useNarrowPane";
type NoteTarget = { id: string; key: number };
type InboxTarget = { reference: string; id: string; key: number };

/** Hidden pages kept besides the selected one; any page holding a draft is kept too. */
const RECENT_PAGES = 3;
// The 680px column, 32px gap, 248px rail, and two 32px gutters.
const TICKET_RAIL_MIN_WIDTH = 1024;

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
  position = null,
  onAdjacent,
  returnLabel,
  outsideResults = false,
  readReviewQueue,
  leaving = false,
  peek = false,
}: {
  outsideResults?: boolean;
  readReviewQueue?: (() => Promise<ReviewQueue>) | undefined;
  /** The pane is fading out after the ticket closed: it takes no input. */
  leaving?: boolean;
  peek?: boolean;
  hidden?: boolean;
  /** The selected ticket's place in the visible list, across pages. */
  position?: TicketListPosition | null;
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
  /**
   * The tickets opened so far, least recently selected first. The selected
   * page, the three before it and any page with an unsaved draft stay mounted
   * (hidden unless selected); the others close and open again from the cache.
   */
  opened?: string[];
  /** The followed mention can be judged: the selected ticket's record is current. */
  onMentionReady: (reference: string) => void;
  /** The followed mention ends: the selected ticket moved to or from Trash. */
  onClearMention: () => void;
  /** A complete Ticket already read for the list, retained while its fresh read runs. */
  preview?: Ticket | undefined;
  projects: Project[];
  plans: Plan[];
}) {
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
  const pane = useRef<HTMLElement>(null);
  const setPane = useCallback((node: HTMLElement | null) => {
    pane.current = node;
    setBoundary(node);
  }, []);
  const narrowHeader = useNarrowPane(pane, 560);
  const scroller = useRef<HTMLDivElement>(null);
  const narrow = useNarrowPane(scroller, TICKET_RAIL_MIN_WIDTH, true);
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
  const recovery = useDraftRecovery();
  const known = useKnownTicket();
  const recent = opened
    .filter((reference) => reference !== selected)
    .slice(-RECENT_PAGES);
  const kept = opened.filter((reference) => {
    if (reference === selected || recent.includes(reference)) return true;
    const id = known(reference)?.id;
    return id !== undefined && hasTicketDraft(recovery, id);
  });
  // A ticket closed a moment ago is still held on screen: it is not one to
  // move from, so reopening inside the close is not a swap.
  const swap = usePageSwap(leaving ? null : selected);
  const pages =
    selected && !kept.includes(selected) ? [...kept, selected] : kept;
  // Pages are memoized, so what they call is the same object on every render.
  const latest = useRef({ open, setSelected, onExpand });
  useEffect(() => {
    latest.current = { open, setSelected, onExpand };
  });
  const [pageActions] = useState<PageActions>(() => ({
    select: (reference) => latest.current.open(reference),
    mention: (target) => latest.current.setSelected(target.reference, target),
    expand: () => latest.current.onExpand(),
  }));
  return (
    <section
      ref={setPane}
      className="ticket-detail"
      hidden={hidden}
      inert={leaving}
      data-expanded={expanded || undefined}
      data-empty={selected === null || undefined}
      aria-labelledby="detail-heading"
    >
      <OverlayBoundary element={boundary}>
        <TicketAgentSession ticket={ticket ?? preview}>
          {(agentLoading) => (
            <>
              <TicketHeader
                selected={selected}
                ticket={ticket}
                scrolled={selected !== null && scrolledReference === selected}
                narrow={narrowHeader}
                expanded={expanded}
                onExpand={onExpand}
                onReturn={onReturn}
                onClose={() => open(null)}
                {...(openGraph && { onOpenGraph: () => showGraph(selected) })}
                position={position}
                outsideResults={outsideResults}
                projects={projects}
                {...(returnLabel && { returnLabel })}
                {...(onAdjacent && { onAdjacent })}
              />
              <div
                ref={scroller}
                className="detail-scroll"
                onScroll={(event) => {
                  const scroller = event.currentTarget;
                  const title = scroller.querySelector<HTMLElement>(
                    ".detail-content:not([hidden], [data-leaving]) .editor-title, .detail-content:not([hidden], [data-leaving]) .detail-title",
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
                <InboxTriageCard />
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
                  <OpenedPage
                    key={reference}
                    reference={reference}
                    active={reference === selected}
                    reading={reference === selected && !hidden && !leaving}
                    expanded={expanded}
                    openFromPeek={peek ? pageActions.expand : undefined}
                    rail={expanded && !narrow}
                    hidden={hidden || reference !== selected}
                    swap={swap.swapped && reference === selected}
                    leaving={reference === swap.leaving}
                    seed={reference === selected ? preview : undefined}
                    readReviewQueue={
                      reference === selected ? readReviewQueue : undefined
                    }
                    projects={projects}
                    plans={plans}
                    inboxTarget={
                      inboxTarget?.reference === reference ? inboxTarget : null
                    }
                    mention={mention?.reference === reference ? mention : null}
                    actions={pageActions}
                  />
                ))}
              </div>
            </>
          )}
        </TicketAgentSession>
      </OverlayBoundary>
    </section>
  );
}

type PageActions = {
  select: (reference: string | null) => void;
  mention: (target: MentionTarget) => void;
  expand: () => void;
};

/**
 * One opened Ticket's page. It renders again only when its own inputs change,
 * not for the other pages or for the header above them.
 */
const OpenedPage = memo(function OpenedPage({
  reference,
  active,
  reading,
  expanded,
  openFromPeek,
  rail,
  hidden,
  swap,
  leaving,
  seed,
  projects,
  plans,
  readReviewQueue,
  inboxTarget,
  mention,
  actions,
}: {
  reference: string;
  active: boolean;
  reading: boolean;
  expanded: boolean;
  openFromPeek: (() => void) | undefined;
  rail: boolean;
  hidden: boolean;
  swap: boolean;
  leaving: boolean;
  seed: Ticket | undefined;
  projects: Project[];
  plans: Plan[];
  readReviewQueue: (() => Promise<ReviewQueue>) | undefined;
  /** The Inbox note to show, when it is on this page. */
  inboxTarget: InboxTarget | null;
  /** The mention being followed, when it is on this page. */
  mention: FollowedMention | null;
  actions: PageActions;
}) {
  return (
    <OpenTicket reference={reference} seed={seed} hidden={hidden}>
      <TicketPage
        active={active}
        reading={reading}
        expanded={expanded}
        openFromPeek={openFromPeek}
        rail={rail}
        swap={swap}
        leaving={leaving}
        projects={projects}
        plans={plans}
        readReviewQueue={readReviewQueue}
        select={actions.select}
        noteTarget={newest(
          inboxTarget,
          mention?.noteId ? { id: mention.noteId, key: mention.key } : null,
        )}
        mention={mention && !mention.noteId && mention.ready ? mention : null}
        onMention={actions.mention}
      />
    </OpenTicket>
  );
});

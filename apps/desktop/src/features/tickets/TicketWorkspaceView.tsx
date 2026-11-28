import { useInboxTriage, triageId } from "./inbox-triage-context";
import { ChatDetail } from "@/features/chats/ChatDetail";
import "@/features/chats/chats.css";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useDefaultLayout,
  useGroupRef,
  usePanelRef,
  type Layout,
} from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "cn";
import { setPreference, usePreferences } from "@/lib/preferences";
import { PlanFlow } from "@/features/plans/PlanFlow";
import { PlanHeader, type PlanMode } from "@/features/plans/PlanHeader";
import { PlanOverview } from "@/features/plans/PlanOverview";
import { planWorkModel } from "@/features/plans/plan-work-model";
import { useNarrowPane } from "@/features/tickets/useNarrowPane";
import {
  usePaneMotion,
  type PaneMode,
} from "@/features/tickets/use-pane-motion";
import { usePaneWidths } from "@/features/tickets/use-pane-widths";
import "@/features/tickets/ticket-pane-motion.css";
import { usePlanView } from "@/features/plans/usePlanView";
import { TicketDetailPane } from "@/features/tickets/TicketDetailPane";
import { useFiltersMenu } from "@/features/tickets/filters-menu";
import {
  PlanListControls,
  TicketListPane,
} from "@/features/tickets/TicketListPane";
import type { BulkEdit } from "@/features/tickets/useBulkEdit";
import type { TicketWorkspace } from "@/features/tickets/useTicketWorkspace";
import { Visibility } from "@/lib/workspace-reads";

const DETAIL_PANEL_STYLE = {
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
} as const;
/** Split mode is measured on the content panel; below 880px the ticket replaces its list. */
const STACK_MIN_WIDTH = 880;
const BOARD_SPLIT: Layout = { list: 44, detail: 56 };

/**
 * Arranges the list and detail panes and the split, expanded, and narrow
 * modes between them, including where focus lands when the mode changes.
 */
export function TicketWorkspaceView({
  workspace,
  bulk,
  hidden,
  inboxTarget,
  onCreate,
  inbox,
  projectNotice,
}: {
  workspace: TicketWorkspace;
  bulk: BulkEdit;
  hidden: boolean;
  inboxTarget: { reference: string; id: string; key: number } | null;
  onCreate: (trigger: HTMLButtonElement, status?: string) => void;
  /**
   * The Inbox, when it is the view: it takes the list pane's place and opens
   * entries in the detail pane beside it, a triage split (S6).
   */
  inbox?: ReactNode;
  projectNotice?: ReactNode;
}) {
  const { selected, setSelected, clearMention } = workspace;
  const inboxMode = Boolean(inbox);
  const triage = useInboxTriage();
  const displayedSelection =
    selected ??
    (inboxMode && triage?.selection ? triageId(triage.selection) : null);
  // Entering or leaving the Inbox starts without an open ticket: the detail
  // beside it belongs to the list it was opened from.
  const wasInbox = useRef(inboxMode);
  useLayoutEffect(() => {
    if (wasInbox.current === inboxMode) return;
    wasInbox.current = inboxMode;
    if (selected) setSelected(null);
  }, [inboxMode, selected, setSelected]);
  // This view is hidden, not unmounted, when another view opens. Leaving counts as
  // navigating, so a followed mention is not still highlighted on return.
  useEffect(() => {
    if (hidden) clearMention();
  }, [hidden, clearMention]);
  const { openTickets } = usePreferences();
  const [expanded, setExpanded] = useState(false);
  const [narrowDetail, setNarrowDetail] = useState(false);
  const listRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  // The content panel’s width, not the window’s: collapsing the sidebar gives it back.
  const narrow = useNarrowPane(workspaceRef, STACK_MIN_WIDTH);
  // Overview and Flow are scoped to one visit. List and Board use the
  // remembered layout shared with the global ticket workspace.
  const planScope = workspace.trash ? "" : workspace.navigation.plan;
  const [planView, setPlanView] = useState<
    "overview" | "tickets" | "dependencies"
  >("overview");
  const [shownNavigation, setShownNavigation] = useState(workspace.navigation);
  if (shownNavigation !== workspace.navigation) {
    setShownNavigation(workspace.navigation);
    setPlanView("overview");
  }
  useEffect(() => {
    // A new Plan opens with its title in view, not where the last one scrolled.
    for (
      let node: HTMLElement | null = listRef.current;
      node && !node.classList.contains("ticket-workspace");
      node = node.parentElement
    )
      node.scrollTop = 0;
    const rows = listRef.current?.querySelector(
      ".ticket-scroll, .plan-overview-scroll",
    );
    if (rows) rows.scrollTop = 0;
  }, [workspace.navigation]);
  const planState = usePlanView(planScope);
  const scopedPlan = workspace.plans.find((item) => item.id === planScope);
  const filtersMenu = useFiltersMenu();
  const dependenciesOpen =
    planView === "dependencies" && scopedPlan && !inboxMode;
  const overviewPlan =
    planView === "overview" && !inboxMode ? scopedPlan : undefined;
  const ticketLayout = overviewPlan ? "list" : workspace.layout;
  const board = ticketLayout === "board" && !inboxMode;
  const overviewMembers = overviewPlan ? planState.view?.members : undefined;
  const overviewWork = useMemo(
    () => (overviewMembers ? planWorkModel(overviewMembers) : null),
    [overviewMembers],
  );
  const overviewOrder = useMemo(
    () =>
      overviewWork
        ? Object.values(overviewWork.sections)
            .flat()
            .map(({ ticket }) => ticket.reference)
        : [],
    [overviewWork],
  );
  const overviewIndex = selected ? overviewOrder.indexOf(selected) : -1;
  const overviewPosition =
    overviewIndex < 0
      ? null
      : { index: overviewIndex + 1, total: overviewOrder.length };
  const openAdjacent = (direction: 1 | -1) => {
    if (!overviewPlan) return workspace.openAdjacent(direction);
    if (overviewIndex < 0) return;
    const target = overviewOrder[overviewIndex + direction];
    if (target) setSelected(target);
  };
  const setPlanMode = (mode: PlanMode) => {
    if (mode === "overview" || mode === "dependencies") {
      setPlanView(mode);
      setNarrowDetail(mode === "dependencies" || selected !== null);
    } else if (setPreference("ticketLayout", mode)) {
      setPlanView("tickets");
      setNarrowDetail(selected !== null);
    } else
      workspace.setError(
        "Could not remember ticket layout. Check local storage and try again.",
      );
  };
  const listSplit = useDefaultLayout({
    // Versioned: layouts saved by earlier builds (468px list) must not override
    // the 360px default.
    id: "ticketd.workspace.v3",
  });
  const boardSplit = useDefaultLayout({ id: "ticketd.workspace.board.v1" });
  const inboxSplit = useDefaultLayout({ id: "ticketd.workspace.inbox.v1" });
  const splitMode = inboxMode ? "inbox" : ticketLayout;
  const groupRef = useGroupRef();
  const listPanelRef = usePanelRef();
  const activeSplit = useRef<"inbox" | "list" | "board">(splitMode);
  const splitLayouts = useRef<{
    list: Layout | undefined;
    inbox: Layout | undefined;
    board: Layout;
  }>({
    list: listSplit.defaultLayout,
    inbox: inboxSplit.defaultLayout,
    board: boardSplit.defaultLayout ?? BOARD_SPLIT,
  });
  useLayoutEffect(() => {
    if (activeSplit.current === splitMode) return;
    activeSplit.current = splitMode;
    const layout = splitLayouts.current[splitMode];
    // Change the library's layout without remounting the detail editor or board scrollers.
    if (layout) groupRef.current?.setLayout(layout);
    else listPanelRef.current?.resize(splitMode === "inbox" ? 392 : 360);
  }, [splitMode, groupRef, listPanelRef]);
  const focusPane = useRef<"detail" | { reference: string | null } | null>(
    null,
  );
  const boardScrollLeft = useRef<number | null>(null);
  const overviewTrigger = useRef<{
    reference: string;
    element: HTMLElement;
  } | null>(null);
  useLayoutEffect(() => {
    if (focusPane.current === "detail")
      document.getElementById("detail-heading")?.focus();
    if (focusPane.current && focusPane.current !== "detail") {
      const { reference } = focusPane.current;
      const board =
        listRef.current?.querySelector<HTMLElement>(".ticket-board");
      if (board && boardScrollLeft.current !== null)
        board.scrollLeft = boardScrollLeft.current;
      // Closing clears selection before this effect runs. Keep the ticket being
      // viewed at return time, including navigation within details, independently.
      const trigger = overviewTrigger.current;
      const target =
        reference &&
        overviewPlan &&
        trigger?.reference === reference &&
        listRef.current?.contains(trigger.element)
          ? trigger.element
          : reference
            ? listRef.current?.querySelector<HTMLElement>(
                overviewPlan
                  ? `[data-overview-reference="${reference}"]`
                  : board
                    ? `[data-board-reference="${reference}"]`
                    : `[data-ticket-reference="${reference}"]`,
              )
            : null;
      (target ?? document.getElementById("tickets-heading"))?.focus({
        preventScroll: true,
      });
    }
    focusPane.current = null;
  });
  // On the board an open card is a peek over its right side; the columns keep
  // their width (S5). Narrow windows stack as before; Expand takes the page.
  // The panes' motion (use-pane-motion): the layout changes at once and a pane
  // that has just left stays on screen for one exit. On the board the document
  // keeps its peek while it fades out after Escape.
  const mode: PaneMode = !displayedSelection
    ? "closed"
    : expanded
      ? "expanded"
      : "split";
  const { arrival, leaving } = usePaneMotion(mode);
  const detailLeaving = leaving?.pane === "detail";
  const peek =
    board &&
    !narrow &&
    !expanded &&
    (selected !== null || (detailLeaving && leaving.from === "split"));
  // A pane that stays for its exit is out of the panel library's layout, so it
  // is placed over the others at the width it had. That width is the one it had
  // beside the other pane: by the time this commit's effects run the layout has
  // already changed, and the panel library reports the whole group.
  const paneWidths = usePaneWidths(workspaceRef, mode);
  useLayoutEffect(() => {
    if (!leaving || leaving.from !== "split" || narrow || board) return;
    const width = paneWidths.current[leaving.pane];
    if (width === null) return;
    const host = workspaceRef.current;
    host?.style.setProperty("--pane-leaving-width", `${width}px`);
    return () => void host?.style.removeProperty("--pane-leaving-width");
  }, [leaving, narrow, board, paneWidths]);
  // The document owns J/K and Escape unless editing or an overlay owns them.
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        !["Escape", "j", "k"].includes(event.key) ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        // A held J or K swaps on every repeat, as it does from the list (the
        // input guard makes each one instant). A held Escape closes once.
        (event.repeat && event.key === "Escape") ||
        !(target instanceof HTMLElement) ||
        !target.closest("#detail") ||
        target.isContentEditable ||
        target.closest(
          "input, textarea, select, [role=combobox], [role=menu], [role=dialog]",
        )
      )
        return;
      event.preventDefault();
      if (event.key === "Escape") {
        focusPane.current = { reference: selected };
        setSelected(null);
      } else openAdjacent(event.key === "j" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const [previousNarrow, setPreviousNarrow] = useState(narrow);
  if (previousNarrow !== narrow) {
    setPreviousNarrow(narrow);
    if (narrow && selected) setNarrowDetail(true);
  }
  const [previousSelection, setPreviousSelection] =
    useState(displayedSelection);
  if (previousSelection !== displayedSelection) {
    setPreviousSelection(displayedSelection);
    setNarrowDetail(displayedSelection !== null);
    if (!displayedSelection) setExpanded(false);
  }
  // Choosing a sidebar scope while a ticket is open shows that scope's list, even
  // where the panes are stacked and the ticket would otherwise keep the screen.
  const [previousNavigation, setPreviousNavigation] = useState(
    workspace.navigation,
  );
  if (previousNavigation !== workspace.navigation) {
    setPreviousNavigation(workspace.navigation);
    setNarrowDetail(false);
  }
  return (
    <Visibility hidden={hidden}>
      <div
        ref={workspaceRef}
        className="plan-workspace"
        hidden={hidden}
        data-plan={scopedPlan ? "" : undefined}
      >
        {scopedPlan && !inboxMode && (
          <PlanHeader
            key={scopedPlan.id}
            plan={scopedPlan}
            plans={workspace.plans}
            state={planState}
            mode={
              overviewPlan
                ? "overview"
                : dependenciesOpen
                  ? "dependencies"
                  : workspace.layout
            }
            onModeChange={setPlanMode}
            controls={
              <PlanListControls
                workspace={workspace}
                filtersMenu={filtersMenu}
              />
            }
          />
        )}
        {dependenciesOpen && !inboxMode && (
          <PlanFlow
            key={`flow:${scopedPlan.id}`}
            id={scopedPlan.id}
            revision={workspace.revision}
            onOpen={(reference) => {
              setPlanView("tickets");
              setSelected(reference);
              setNarrowDetail(true);
            }}
          />
        )}
        <ResizablePanelGroup
          orientation="horizontal"
          resizeTargetMinimumSize={{ fine: 8, coarse: 44 }}
          // The split handle is hidden here; left enabled, the panel library still
          // claims presses nearby, which stopped the sidebar's New menu from opening.
          disabled={narrow || expanded || !displayedSelection || peek}
          className={cn(
            "ticket-workspace",
            expanded && "expanded",
            narrowDetail && "narrow-detail",
            board && "board-layout",
            !displayedSelection && "unselected",
          )}
          data-narrow={narrow || undefined}
          data-peek={peek || undefined}
          data-pane-arrival={arrival ?? undefined}
          data-pane-leaving={leaving?.pane}
          groupRef={groupRef}
          defaultLayout={
            splitMode === "inbox"
              ? inboxSplit.defaultLayout
              : splitMode === "board"
                ? (boardSplit.defaultLayout ?? BOARD_SPLIT)
                : listSplit.defaultLayout
          }
          onLayoutChanged={(layout, meta) => {
            const mode = activeSplit.current;
            if (meta.isUserInteraction || !splitLayouts.current[mode])
              splitLayouts.current[mode] = meta.requestedLayout ?? layout;
            // Full-width modes and window constraints must not overwrite the preferred split.
            if (meta.isUserInteraction)
              (mode === "inbox"
                ? inboxSplit
                : mode === "board"
                  ? boardSplit
                  : listSplit
              ).onLayoutChanged(layout, meta);
          }}
          hidden={hidden || Boolean(dependenciesOpen && !inboxMode)}
        >
          <ResizablePanel
            id="list"
            panelRef={listPanelRef}
            minSize={inboxMode ? 360 : 300}
            maxSize={
              !inboxMode && !board && selected && !narrow && !expanded
                ? 480
                : undefined
            }
            defaultSize={inboxMode ? 392 : 360}
          >
            {inbox ??
              (overviewPlan ? (
                <PlanOverview
                  key={overviewPlan.id}
                  plan={overviewPlan}
                  state={planState}
                  work={overviewWork}
                  paneRef={listRef}
                  selected={selected}
                  onOpen={(reference, trigger) => {
                    overviewTrigger.current = trigger
                      ? { reference, element: trigger }
                      : null;
                    setSelected(reference);
                    setNarrowDetail(true);
                    if (narrow) focusPane.current = "detail";
                  }}
                />
              ) : (
                <TicketListPane
                  workspace={workspace}
                  bulk={bulk}
                  listRef={listRef}
                  planState={planState}
                  projectNotice={projectNotice}
                  {...(scopedPlan && { filtersMenu })}
                  onCreate={onCreate}
                  onOpen={(reference) => {
                    if (workspace.layout === "board")
                      boardScrollLeft.current =
                        listRef.current?.querySelector(".ticket-board")
                          ?.scrollLeft ?? 0;
                    setSelected(reference);
                    setNarrowDetail(true);
                    if (narrow) focusPane.current = "detail";
                    // The Open tickets preference: a ticket opened from the list may
                    // take the full width. Narrow windows already show it that way.
                    else if (!board && openTickets === "expanded") {
                      setExpanded(true);
                      focusPane.current = "detail";
                    }
                  }}
                />
              ))}
          </ResizablePanel>
          <ResizableHandle
            overlay
            className="split-handle"
            aria-label="Resize ticket list"
          />
          <ResizablePanel
            id="detail"
            minSize={520}
            // The panel library makes its content box `overflow: auto` with an
            // auto height, so a percentage-height child never gets a bound and the
            // wheel scrolls nothing. Bound it here; `.detail-scroll` is the scroller.
            style={DETAIL_PANEL_STYLE}
          >
            {inboxMode && triage?.chatId ? (
              <div className="inbox-chat-detail" data-inbox-chat>
                <ChatDetail
                  id={triage.chatId}
                  expanded={expanded}
                  single={narrow || expanded}
                  onExpand={() => setExpanded(true)}
                  onReturn={() => triage.openChat(null)}
                  onClose={() => triage.openChat(null)}
                  focusRequest
                  onRequestsAnswered={() =>
                    workspaceRef.current
                      ?.querySelector<HTMLElement>(
                        '.inbox-entry[aria-current="true"] .inbox-ticket',
                      )
                      ?.focus({ preventScroll: true })
                  }
                />
              </div>
            ) : null}
            <TicketDetailPane
              workspace={workspace}
              hidden={inboxMode && !!triage?.chatId}
              leaving={detailLeaving}
              {...(inboxMode && { context: "inbox" as const })}
              {...(overviewPlan && {
                overview: {
                  position: overviewPosition,
                  onAdjacent: openAdjacent,
                  loaded: overviewWork !== null,
                },
              })}
              expanded={expanded}
              inboxTarget={inboxTarget}
              onExpand={() => {
                setExpanded(true);
                focusPane.current = "detail";
              }}
              onReturn={() => {
                setExpanded(false);
                setNarrowDetail(false);
                focusPane.current = { reference: selected };
              }}
              onSelect={(value, mention) => {
                if (value === null) focusPane.current = { reference: selected };
                setSelected(value, mention);
              }}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </Visibility>
  );
}

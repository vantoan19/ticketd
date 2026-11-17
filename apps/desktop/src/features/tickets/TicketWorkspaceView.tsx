import { useInboxTriage, triageId } from "./inbox-triage-context";
import { ChatDetail } from "@/features/chats/ChatDetail";
import "@/features/chats/chats.css";
import {
  useEffect,
  useLayoutEffect,
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
import { PlanHeader } from "@/features/plans/PlanHeader";
import { useNarrowPane } from "@/features/tickets/useNarrowPane";
import {
  usePaneMotion,
  type PaneMode,
} from "@/features/tickets/use-pane-motion";
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
  const board = workspace.layout === "board" && !inboxMode;
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
  // Dependencies are temporary; ticket layouts share the remembered preference.
  const [showDependencies, setShowDependencies] = useState(false);
  const planScope = workspace.trash ? "" : workspace.navigation.plan;
  const [shownPlan, setShownPlan] = useState(planScope);
  if (shownPlan !== planScope) {
    setShownPlan(planScope);
    setShowDependencies(false);
  }
  useEffect(() => {
    // A new Plan opens with its title in view, not where the last one scrolled.
    for (
      let node: HTMLElement | null = listRef.current;
      node && !node.classList.contains("ticket-workspace");
      node = node.parentElement
    )
      node.scrollTop = 0;
    // The rows scroll in their own element inside the list pane.
    const rows = listRef.current?.querySelector(".ticket-scroll");
    if (rows) rows.scrollTop = 0;
  }, [planScope]);
  const planState = usePlanView(planScope);
  const scopedPlan = workspace.plans.find((item) => item.id === planScope);
  // The Plan header's Filters menu and the list's chip row share one state.
  const filtersMenu = useFiltersMenu();
  const dependenciesOpen = showDependencies && scopedPlan;
  const showTickets = () => {
    setShowDependencies(false);
    setNarrowDetail(selected !== null);
  };
  const setPlanMode = (mode: "list" | "board" | "dependencies") => {
    if (mode === "dependencies") {
      setShowDependencies(true);
      setNarrowDetail(true);
    } else if (setPreference("ticketLayout", mode)) showTickets();
    else
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
  const splitMode = inboxMode ? "inbox" : workspace.layout;
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
      const target = reference
        ? listRef.current?.querySelector<HTMLButtonElement>(
            workspace.layout === "board"
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
  // is placed over the others at the width it had.
  const detailPanelRef = usePanelRef();
  useLayoutEffect(() => {
    if (!leaving || leaving.from !== "split" || narrow || board) return;
    const panel = leaving.pane === "detail" ? detailPanelRef : listPanelRef;
    const width = panel.current?.getSize().inPixels;
    if (width === undefined) return;
    const host = workspaceRef.current;
    host?.style.setProperty("--pane-leaving-width", `${width}px`);
    return () => void host?.style.removeProperty("--pane-leaving-width");
  }, [leaving, narrow, board, detailPanelRef, listPanelRef]);
  // The document owns J/K and Escape unless editing or an overlay owns them.
  const peekState = useRef({ peek, selected });
  useEffect(() => {
    peekState.current = { peek, selected };
  });
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
        event.repeat ||
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
        focusPane.current = { reference: peekState.current.selected };
        setSelected(null);
      } else workspace.openAdjacent(event.key === "j" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, setSelected, workspace]);
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
            mode={dependenciesOpen ? "dependencies" : workspace.layout}
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
              showTickets();
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
            !displayedSelection && !detailLeaving && "unselected",
          )}
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
            {inbox ?? (
              <TicketListPane
                workspace={workspace}
                bulk={bulk}
                listRef={listRef}
                planState={planState}
                {...(scopedPlan && { filtersMenu })}
                onCreate={onCreate}
                onOpen={(reference) => {
                  if (workspace.layout === "board")
                    boardScrollLeft.current =
                      listRef.current?.querySelector(".ticket-board")
                        ?.scrollLeft ?? 0;
                  setShowDependencies(false);
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
            )}
          </ResizablePanel>
          <ResizableHandle
            overlay
            className="split-handle"
            aria-label="Resize ticket list"
          />
          <ResizablePanel
            id="detail"
            panelRef={detailPanelRef}
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

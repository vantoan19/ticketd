import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { PlanDependencies } from "@/features/plans/PlanDependencies";
import { PlanHeader } from "@/features/plans/PlanHeader";
import { useNarrowPane } from "@/features/tickets/useNarrowPane";
import { usePlanView } from "@/features/plans/usePlanView";
import { TicketDetailPane } from "@/features/tickets/TicketDetailPane";
import { FilterDockContext } from "@/features/tickets/filter-dock";
import { TicketListPane } from "@/features/tickets/TicketListPane";
import type { BulkEdit } from "@/features/tickets/useBulkEdit";
import type { TicketWorkspace } from "@/features/tickets/useTicketWorkspace";

const DETAIL_PANEL_STYLE = {
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
} as const;
/** The list pane’s 360px plus the detail pane’s 480px: below this the panes stack. */
const STACK_MIN_WIDTH = 840;
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
}: {
  workspace: TicketWorkspace;
  bulk: BulkEdit;
  hidden: boolean;
  inboxTarget: { reference: string; id: string; key: number } | null;
  onCreate: (trigger: HTMLButtonElement, status?: string) => void;
}) {
  const { selected, setSelected, clearMention } = workspace;
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
  // The Filters panel docks beside the list, so the detail pane makes room.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterDock = useMemo(
    () => ({
      open: filtersOpen,
      setOpen: setFiltersOpen,
      anchor:
        // Stacked, the list fills the window: no room beside it, so use collision handling.
        workspace.layout === "board" || narrow
          ? null
          : {
              // Always a measurable: the panel measures the list pane when it opens.
              current: {
                getBoundingClientRect: () =>
                  (
                    listRef.current?.closest<HTMLElement>("#list") ??
                    document.getElementById("list")
                  )?.getBoundingClientRect() ?? new DOMRect(),
              } as HTMLElement,
            },
    }),
    [filtersOpen, workspace.layout, narrow],
  );
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
  const planState = usePlanView(
    planScope,
    workspace.revision,
    workspace.refresh,
  );
  const scopedPlan = workspace.plans.find((item) => item.id === planScope);
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
    // the 384px default.
    id: "ticketd.workspace.v2",
  });
  const boardSplit = useDefaultLayout({ id: "ticketd.workspace.board.v1" });
  const groupRef = useGroupRef();
  const listPanelRef = usePanelRef();
  const activeSplit = useRef(workspace.layout);
  const splitLayouts = useRef<{ list: Layout | undefined; board: Layout }>({
    list: listSplit.defaultLayout,
    board: boardSplit.defaultLayout ?? BOARD_SPLIT,
  });
  useLayoutEffect(() => {
    if (activeSplit.current === workspace.layout) return;
    activeSplit.current = workspace.layout;
    const layout = splitLayouts.current[workspace.layout];
    // Change the library's layout without remounting the detail editor or board scrollers.
    if (layout) groupRef.current?.setLayout(layout);
    else listPanelRef.current?.resize(384);
  }, [workspace.layout, groupRef, listPanelRef]);
  const focusPane = useRef<"detail" | "list" | null>(null);
  const boardReturn = useRef<{ reference: string; scrollLeft: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (focusPane.current === "detail")
      document.getElementById("detail-heading")?.focus();
    if (focusPane.current === "list") {
      const returned =
        workspace.layout === "board" ? boardReturn.current : null;
      const board =
        listRef.current?.querySelector<HTMLElement>(".ticket-board");
      if (board && returned) board.scrollLeft = returned.scrollLeft;
      const target =
        (returned &&
          listRef.current?.querySelector<HTMLButtonElement>(
            `[data-board-reference="${returned.reference}"]`,
          )) ||
        listRef.current?.querySelector<HTMLButtonElement>(
          '.board-card[aria-pressed="true"], .ticket-row[aria-pressed="true"]',
        );
      (target ?? document.getElementById("tickets-heading"))?.focus({
        preventScroll: true,
      });
    }
    focusPane.current = null;
  });
  const [previousNarrow, setPreviousNarrow] = useState(narrow);
  if (previousNarrow !== narrow) {
    setPreviousNarrow(narrow);
    if (narrow && selected) setNarrowDetail(true);
  }
  const [previousSelection, setPreviousSelection] = useState(selected);
  if (previousSelection !== selected) {
    setPreviousSelection(selected);
    setNarrowDetail(selected !== null);
    if (!selected) setExpanded(false);
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
    <FilterDockContext.Provider value={filterDock}>
      <div
        ref={workspaceRef}
        className="plan-workspace"
        hidden={hidden}
        data-plan={scopedPlan ? "" : undefined}
      >
        {scopedPlan && (
          <PlanHeader
            key={scopedPlan.id}
            plan={scopedPlan}
            plans={workspace.plans}
            state={planState}
            mode={dependenciesOpen ? "dependencies" : workspace.layout}
            onModeChange={setPlanMode}
          />
        )}
        {dependenciesOpen && (
          <PlanDependencies
            id={scopedPlan.id}
            revision={workspace.revision}
            projects={workspace.projects}
            refresh={workspace.refresh}
            onClose={showTickets}
            archived={scopedPlan.archived}
            onOpen={(reference) => {
              showTickets();
              setSelected(reference);
              setNarrowDetail(true);
            }}
          />
        )}
        <ResizablePanelGroup
          orientation="horizontal"
          // The split handle is hidden here; left enabled, the panel library still
          // claims presses nearby, which stopped the sidebar's New menu from opening.
          disabled={
            narrow || expanded || (workspace.layout === "board" && !selected)
          }
          className={cn(
            "ticket-workspace",
            expanded && "expanded",
            narrowDetail && "narrow-detail",
            workspace.layout === "board" && "board-layout",
            !selected && "board-unselected",
          )}
          data-filters-open={filtersOpen ? "" : undefined}
          groupRef={groupRef}
          defaultLayout={
            workspace.layout === "board"
              ? (boardSplit.defaultLayout ?? BOARD_SPLIT)
              : listSplit.defaultLayout
          }
          onLayoutChanged={(layout, meta) => {
            const mode = activeSplit.current;
            if (meta.isUserInteraction || !splitLayouts.current[mode])
              splitLayouts.current[mode] = meta.requestedLayout ?? layout;
            // Full-width modes and window constraints must not overwrite the preferred split.
            if (meta.isUserInteraction)
              (mode === "board" ? boardSplit : listSplit).onLayoutChanged(
                layout,
                meta,
              );
          }}
          hidden={hidden || Boolean(dependenciesOpen)}
        >
          <ResizablePanel
            id="list"
            panelRef={listPanelRef}
            minSize={360}
            defaultSize={384}
          >
            <TicketListPane
              workspace={workspace}
              bulk={bulk}
              listRef={listRef}
              planState={planState}
              onCreate={onCreate}
              onOpen={(reference) => {
                if (workspace.layout === "board")
                  boardReturn.current = {
                    reference,
                    scrollLeft:
                      listRef.current?.querySelector(".ticket-board")
                        ?.scrollLeft ?? 0,
                  };
                setShowDependencies(false);
                setSelected(reference);
                setNarrowDetail(true);
                if (narrow) focusPane.current = "detail";
                // The Open tickets preference: a ticket opened from the list may
                // take the full width. Narrow windows already show it that way.
                else if (openTickets === "expanded") {
                  setExpanded(true);
                  focusPane.current = "detail";
                }
              }}
            />
          </ResizablePanel>
          <ResizableHandle
            className="split-handle"
            aria-label="Resize ticket list"
          />
          <ResizablePanel
            id="detail"
            minSize={480}
            // The panel library makes its content box `overflow: auto` with an
            // auto height, so a percentage-height child never gets a bound and the
            // wheel scrolls nothing. Bound it here; `.detail-scroll` is the scroller.
            style={DETAIL_PANEL_STYLE}
          >
            <TicketDetailPane
              workspace={workspace}
              expanded={expanded}
              inboxTarget={inboxTarget}
              onExpand={() => {
                setExpanded(true);
                focusPane.current = "detail";
              }}
              onReturn={() => {
                setExpanded(false);
                setNarrowDetail(false);
                focusPane.current = "list";
              }}
              onSelect={(value, mention) => {
                if (value === null) focusPane.current = "list";
                setSelected(value, mention);
              }}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </FilterDockContext.Provider>
  );
}

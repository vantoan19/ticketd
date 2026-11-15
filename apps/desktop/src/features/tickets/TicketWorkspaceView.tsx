import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const peek =
    workspace.layout === "board" && selected !== null && !narrow && !expanded;
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
    <>
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
          disabled={narrow || expanded || !selected || peek}
          className={cn(
            "ticket-workspace",
            expanded && "expanded",
            narrowDetail && "narrow-detail",
            workspace.layout === "board" && "board-layout",
            !selected && "unselected",
          )}
          data-peek={peek || undefined}
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
                  boardScrollLeft.current =
                    listRef.current?.querySelector(".ticket-board")
                      ?.scrollLeft ?? 0;
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
            {/* Escape closes the peek, unless a field, menu or dialog has it. */}
            <div
              className="contents"
              onKeyDown={(event) => {
                if (!peek || event.key !== "Escape" || event.defaultPrevented)
                  return;
                const target = event.target as HTMLElement;
                if (
                  target.isContentEditable ||
                  target.closest(
                    "input, textarea, select, [role=combobox], [role=menu], [role=dialog]",
                  )
                )
                  return;
                event.preventDefault();
                focusPane.current = { reference: selected };
                setSelected(null);
              }}
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
                  focusPane.current = { reference: selected };
                }}
                onSelect={(value, mention) => {
                  if (value === null)
                    focusPane.current = { reference: selected };
                  setSelected(value, mention);
                }}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </>
  );
}

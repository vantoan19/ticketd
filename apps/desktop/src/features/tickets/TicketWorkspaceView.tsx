import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "cn";
import { usePreferences } from "@/lib/preferences";
import { PlanDependencies } from "@/features/plans/PlanDependencies";
import { PlanHeader } from "@/features/plans/PlanHeader";
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
const NARROW_QUERY = "(max-width: 1071px)";

function subscribeNarrow(callback: () => void) {
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function useNarrow() {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

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
  // Plan dependencies take the detail pane. Each Plan opens on its list.
  const [planMode, setPlanModeState] = useState<"list" | "dependencies">(
    "list",
  );
  const planScope = workspace.trash ? "" : workspace.navigation.plan;
  const [shownPlan, setShownPlan] = useState(planScope);
  if (shownPlan !== planScope) {
    setShownPlan(planScope);
    setPlanModeState("list");
  }
  useEffect(() => {
    // A new Plan opens with its title in view, not where the last one scrolled.
    for (
      let node: HTMLElement | null = listRef.current;
      node && !node.classList.contains("ticket-workspace");
      node = node.parentElement
    )
      node.scrollTop = 0;
  }, [planScope]);
  const planState = usePlanView(
    planScope,
    workspace.revision,
    workspace.refresh,
  );
  const scopedPlan = workspace.plans.find((item) => item.id === planScope);
  const dependenciesOpen = planMode === "dependencies" && scopedPlan;
  const setPlanMode = (mode: "list" | "dependencies") => {
    setPlanModeState(mode);
    if (mode === "dependencies") setNarrowDetail(true);
    else setNarrowDetail(selected !== null);
  };
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "ticketd.workspace",
  });
  const focusPane = useRef<"detail" | "list" | null>(null);
  useLayoutEffect(() => {
    if (focusPane.current === "detail")
      document.getElementById("detail-heading")?.focus();
    if (focusPane.current === "list") {
      const target = listRef.current?.querySelector<HTMLButtonElement>(
        '[aria-pressed="true"]',
      );
      (target ?? document.getElementById("tickets-heading"))?.focus();
    }
    focusPane.current = null;
  });
  const narrow = useNarrow();
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const showSelected = (event: MediaQueryListEvent) => {
      if (event.matches && selected) setNarrowDetail(true);
    };
    media.addEventListener("change", showSelected);
    return () => media.removeEventListener("change", showSelected);
  }, [selected]);
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
    <div
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
          mode={planMode}
          onModeChange={setPlanMode}
        />
      )}
      {dependenciesOpen && (
        <PlanDependencies
          id={scopedPlan.id}
          revision={workspace.revision}
          projects={workspace.projects}
          refresh={workspace.refresh}
          onClose={() => setPlanMode("list")}
          archived={scopedPlan.archived}
          onOpen={(reference) => {
            setPlanMode("list");
            setSelected(reference);
            setNarrowDetail(true);
          }}
        />
      )}
      <ResizablePanelGroup
        orientation="horizontal"
        // The split handle is hidden here; left enabled, the panel library still
        // claims presses nearby, which stopped the sidebar's New menu from opening.
        disabled={narrow}
        className={cn(
          "ticket-workspace",
          expanded && "expanded",
          narrowDetail && "narrow-detail",
        )}
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        hidden={hidden || Boolean(dependenciesOpen)}
      >
        <ResizablePanel
          id="list"
          minSize={360}
          defaultSize={384}
          className="list-panel"
        >
          <TicketListPane
            workspace={workspace}
            bulk={bulk}
            listRef={listRef}
            planState={planState}
            onCreate={onCreate}
            onOpen={(reference) => {
              setPlanModeState("list");
              setSelected(reference);
              setNarrowDetail(true);
              const narrow = window.matchMedia(NARROW_QUERY).matches;
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
          className="detail-panel"
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
  );
}

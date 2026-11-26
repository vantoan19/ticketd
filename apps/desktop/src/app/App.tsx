import { ticketUnavailable } from "@/features/tickets/inboxModel";
import type { ProjectSourceSetup } from "@/features/projects/ConnectProjectSource";
import { ProjectRemoteNote } from "@/features/projects/ProjectRemoteNote";
import { requestInboxAction } from "@/features/tickets/inbox-commands";
import type { TriageSelection } from "@/features/tickets/inbox-triage-context";
import { InboxTriageProvider } from "@/features/tickets/InboxTriageProvider";
import { requestTicketUpdate } from "@/features/tickets/activity-composer-request";
import { FirstRunGuide } from "@/features/tickets/FirstRunGuide";
import { workspaceClient, type WorkspaceInfo } from "@/lib/api/workspace";
import {
  TicketCommandContext,
  ticketCommandActions,
  type TicketCommandScope,
} from "@/lib/ticket-command-actions";
import { keepWebviewInStep } from "@/lib/webview-scale";
import { setReportedRoute } from "@/lib/error-report";
import { usePageZoom } from "./use-page-zoom";
import { useResponsiveNavigationFocus } from "./use-responsive-navigation-focus";
import { PageZoomStatus } from "./PageZoomStatus";
import { useCommandKeys, type GoTo } from "./use-command-keys";
import {
  ContextGraphNavigation,
  DocumentNavigation,
  PlanNavigation,
  ProjectNavigation,
} from "@/features/documents/navigation";
import type { DocumentCommands } from "@/features/documents/Documents";
import type { AttachmentCommands } from "@/features/attachments/AttachmentLibrary";
import {
  initialSettingsPage,
  resolveSettingsPage,
  type LegacySettingsPageId,
  type SettingsPageId,
} from "@/features/settings/settings-sections";
import { SettingsStateProvider } from "@/features/settings/settings-state";
import { client, type ContextGraph as GraphData } from "@/lib/api/client";
import { countsClient, type SidebarCounts } from "@/lib/api/counts";
import { InboxAttentionProvider } from "@/features/tickets/inbox-attention";
import { CreateTicketDialog } from "@/features/tickets/CreateTicketDialog";
import { useTicketWorkspace } from "@/features/tickets/useTicketWorkspace";
import { useBulkEdit } from "@/features/tickets/useBulkEdit";
import { TicketWorkspaceView } from "@/features/tickets/TicketWorkspaceView";
import {
  WorkspaceSidebar,
  type View,
} from "@/components/layout/WorkspaceSidebar";
import { useReminderNotifications } from "@/features/tickets/useReminderNotifications";
import { usePreferences, useThemeSync } from "@/lib/preferences";
import { useInputModality } from "@/lib/input-modality";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ReturnCrumb, ShellSlotProvider } from "@/components/ui/list-header";
import { NarrowNav } from "@/components/layout/NarrowNav";
import { ViewRegion } from "@/components/layout/ViewRegion";
import { launch } from "@/components/layout/launch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OverlayBoundary } from "@/components/ui/overlay-boundary";
import { WindowBar } from "@/components/layout/WindowBar";
import { UpdatesProvider } from "@/features/updates/UpdatesProvider";
import { useUpdateNotice } from "@/features/updates/update-state";
import { StatusLineRegion, StatusLineSpot } from "@/components/ui/status-line";
import { NewPlanDialog } from "@/features/plans/NewPlanDialog";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
} from "react";
import { matchesShortcut } from "@/lib/shortcuts";
import { WorkspaceReads, useReplaced } from "@/lib/workspace-reads";
import {
  TicketListSync,
  useTicket,
  useTicketChanged,
  type ReturnedTickets,
} from "@/features/tickets/open-ticket";
import { useIsMobile } from "@/hooks/use-mobile";
import { SourceActivityContext } from "@/features/tickets/source-activity";
import { ExitDialog } from "@/features/sync/ExitDialog";
import { SyncStatusProvider } from "@/features/sync/SyncStatusProvider";
import { useSyncNavigation } from "@/features/sync/sync-status";
import { TicketNavigation } from "@/features/tickets/navigation";
import { SettingsNavigation } from "@/lib/settings-navigation";
import {
  SetupActionsContext,
  type SetupActions,
} from "@/features/setup/setup-actions";
import {
  useDraftRecovery,
  useDraftRecoveryGeneration,
  useDraftRecoveryNotices,
} from "@/lib/draft-recovery-context";
import { useStatusLine } from "@/components/ui/use-status-line";
import { WorkspaceNotice } from "./WorkspaceNotice";
import { useBandContinuity } from "./use-band-continuity";
import { BandSlot, WorkspaceBand } from "./WorkspaceBand";
import { workspaceMessages } from "./workspace-messages";
import {
  clearWorkspaceFailure,
  getWorkspaceFailure,
  editingBlockedReason,
  useWorkspaceState,
} from "@/lib/workspace-state";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { RunNavigation } from "@/features/automations/navigation";
import { useAutomationNotifications } from "@/features/automations/useAutomationNotifications";
import { useChatFeature } from "@/features/chats/use-chats";
import { lazyView } from "./lazy-view";

// Each view behind the view switch loads on its first visit; the likely next
// ones load while idle after the first paint (PREFETCHED).
const CommandPalette = lazyView(() =>
  import("./CommandPalette").then((module) => module.CommandPalette),
);
const ContextGraph = lazyView(() =>
  import("@/features/documents/ContextGraph").then(
    (module) => module.ContextGraph,
  ),
);
const WorkspaceGraph = lazyView(() =>
  import("@/features/documents/WorkspaceGraph").then(
    (module) => module.WorkspaceGraph,
  ),
);
const Documents = lazyView(() =>
  import("@/features/documents/Documents").then((module) => module.Documents),
);
const AttachmentLibrary = lazyView(() =>
  import("@/features/attachments/AttachmentLibrary").then(
    (module) => module.AttachmentLibrary,
  ),
);
const Inbox = lazyView(() =>
  import("@/features/tickets/Inbox").then((module) => module.Inbox),
);
const SettingsView = lazyView(() =>
  import("@/features/settings/SettingsView").then(
    (module) => module.SettingsView,
  ),
);
const SettingsNav = lazyView(() =>
  import("@/features/settings/SettingsNav").then(
    (module) => module.SettingsNav,
  ),
);
const PlanList = lazyView(() =>
  import("@/features/plans/PlanList").then((module) => module.PlanList),
);
const Projects = lazyView(() =>
  import("@/features/projects/Projects").then((module) => module.Projects),
);
const ProjectFormDialog = lazyView(() =>
  import("@/features/projects/ProjectFormDialog").then(
    (module) => module.ProjectFormDialog,
  ),
);
const ConnectProjectSource = lazyView(() =>
  import("@/features/projects/ConnectProjectSource").then(
    (module) => module.ConnectProjectSource,
  ),
);
const AutomationsView = lazyView(() =>
  import("@/features/automations/AutomationsView").then(
    (module) => module.AutomationsView,
  ),
);
const ChatsView = lazyView(() =>
  import("@/features/chats/ChatsView").then((module) => module.ChatsView),
);
const PREFETCHED = [
  CommandPalette,
  Inbox,
  Documents,
  PlanList,
  Projects,
  SettingsView,
  SettingsNav,
];

/** Loads the likely next views and the editor once the first paint is done. */
function usePrefetch() {
  useEffect(() => {
    const prefetch = () => {
      for (const view of PREFETCHED) void view.preload().catch(() => {});
      // CodeMirror follows the editor: source mode is its less common path.
      void import("@/features/markdown/MarkdownEditor")
        .then((editor) => editor.LazySourceEditor.preload())
        .catch(() => {});
    };
    if ("requestIdleCallback" in window) {
      const idle = requestIdleCallback(prefetch);
      return () => cancelIdleCallback(idle);
    }
    // WebKit has no idle callback.
    const timer = setTimeout(prefetch, 500);
    return () => clearTimeout(timer);
  }, []);
}

/** True from the first render where `value` is: a hidden view keeps its state. */
function useVisited(value: boolean) {
  const [visited, setVisited] = useState(value);
  if (value && !visited) setVisited(true);
  return visited || value;
}

/** Each top-level view by name, for "Back to …" (Settings returns to it). */
const VIEW_NAMES = {
  tickets: "tickets",
  projects: "Projects",
  "archived-projects": "Projects",
  plans: "Plans",
  "archived-plans": "Archived Plans",
  settings: "Settings",
  inbox: "Inbox",
  documents: "Documents",
  attachments: "Attachments",
  chats: "Chats",
  automations: "Automations",
} as const;

export function App() {
  return (
    <WorkspaceReads>
      {/* One tooltip delay for the whole app (DESIGN.md section 4). */}
      <TooltipProvider>
        <SyncStatusProvider>
          <ChatProvider>
            <InboxAttentionProvider>
              <UpdateShell />
            </InboxAttentionProvider>
          </ChatProvider>
          <ExitDialog />
        </SyncStatusProvider>
      </TooltipProvider>
    </WorkspaceReads>
  );
}

function UpdateShell() {
  const recovery = useDraftRecovery();
  return (
    <UpdatesProvider
      beforeInstall={async () => {
        window.dispatchEvent(new Event("ticketd:window-closing"));
        await recovery.flush();
      }}
    >
      <AppContent />
    </UpdatesProvider>
  );
}

function AppContent() {
  const updateNotice = useUpdateNotice();
  const workspaceReplaced = useReplaced();
  const [chatWorkspace, setChatWorkspace] = useState(0);
  const pageZoom = usePageZoom();
  useEffect(keepWebviewInStep, []);
  const recoveryGeneration = useDraftRecoveryGeneration();
  const recoveryNotices = useDraftRecoveryNotices();
  const workspaceProblem = useWorkspaceState();
  const createDisabledReason =
    workspaceProblem?.problem === "workspace_read_only"
      ? "The workspace is read-only"
      : editingBlockedReason(workspaceProblem);
  const recovery = useDraftRecovery();
  const [view, setViewState] = useState<View>("tickets");
  useEffect(() => setReportedRoute(view), [view]);
  const chat = useChatFeature();
  // Turning Chat off hides its screen at once; the Chats themselves are kept.
  if ((view === "chats" || view === "automations") && !chat.enabled)
    setViewState("tickets");
  // A clicked Chat notification shows the Chats screen; it opens the Chat itself.
  const [seenChatOpen, setSeenChatOpen] = useState(0);
  if (chat.openRequest && chat.openRequest.n !== seenChatOpen) {
    setSeenChatOpen(chat.openRequest.n);
    setViewState("chats");
  }
  // A Chat asked for from a ticket shows the Chats screen; it opens the Chat itself.
  const [seenChatRequest, setSeenChatRequest] = useState(0);
  if (chat.chatRequest && chat.chatRequest.n !== seenChatRequest) {
    setSeenChatRequest(chat.chatRequest.n);
    setViewState("chats");
  }
  const [newChatRequest, setNewChatRequest] = useState(0);
  // Menus and popovers opened in the content panel stay inside it (P3).
  const [contentPanel, setContentPanel] = useState<HTMLElement | null>(null);
  const [settingsSection, setSettingsPage] =
    useState<SettingsPageId>("appearance");
  // A page asked for by an old name opens the page that replaced it.
  const setSettingsSection = useCallback(
    (page: SettingsPageId | LegacySettingsPageId) =>
      setSettingsPage(resolveSettingsPage(page)),
    [],
  );
  const [projectSource, setProjectSource] = useState<
    | ({ mode: "setup" } & ProjectSourceSetup)
    | {
        mode: "review";
        projectId: string;
        resumed?: boolean;
        connection?: string;
        closing?: boolean;
      }
    | {
        mode: "edit_remote";
        projectId: string;
        opening: symbol;
        exit?: "close" | "review" | "archived";
      }
    | null
  >(null);
  useThemeSync();
  useInputModality();
  usePrefetch();
  // Settings replaces the sidebar; Back to tickets returns to the view it left.
  const [viewBeforeSettings, setViewBeforeSettings] =
    useState<typeof view>("tickets");
  // Leaving Settings unmounts its navigation, so focus returns to the sidebar
  // entry that opened it.
  const returnToSettingsEntry = useRef(false);
  useEffect(() => {
    if (view !== "settings" && returnToSettingsEntry.current) {
      returnToSettingsEntry.current = false;
      document.getElementById("sidebar-settings")?.focus();
      // The sidebar comes back under a pointer that has not moved: the row it
      // happens to rest on shows no hover fill until the pointer moves, so only
      // the current view reads as selected (LIVE2-12).
      const root = document.documentElement;
      root.dataset.hoverHeld = "";
      const release = () => {
        delete root.dataset.hoverHeld;
        document.removeEventListener("pointermove", release, true);
      };
      document.addEventListener("pointermove", release, true);
      return release;
    }
  }, [view]);
  const [attachmentCommands, setAttachmentCommands] =
    useState<AttachmentCommands | null>(null);
  const [documentCommands, setDocumentCommands] =
    useState<DocumentCommands | null>(null);
  const [documentListRequest, setDocumentListRequest] = useState(0);
  const [creatingPlan, setCreatingPlan] = useState(false);
  // Settings opens on Set up ticketd until it is finished or hidden.
  const { setupHidden, setupFinished } = usePreferences();
  const setupPending = !setupHidden && !setupFinished;
  const openView = (next: typeof view) => {
    if (next === "documents") {
      // Sidebar "Documents" returns to the list, not to where a reader came from.
      // The reader stays mounted while hidden, so ask it to close from any view.
      setDocumentReturn(null);
      setDocumentTarget(null);
      setDocumentListRequest((count) => count + 1);
    }
    if (next === "settings" && view !== "settings") {
      setViewBeforeSettings(view);
      setSettingsSection(initialSettingsPage({ setupPending }));
    }
    setView(next);
  };
  function reviewProjectSource(projectId: string, connection?: string) {
    setProjectSource({
      mode: "review",
      projectId,
      ...(connection && { connection }),
    });
  }
  function setupProjectSource(setup: ProjectSourceSetup) {
    setProjectSource({ mode: "setup", ...setup });
    openView("settings");
    setSettingsSection("ticket-sources");
  }
  useSyncNavigation({
    openSettings: () => {
      openView("settings");
      setSettingsSection("workspace-sync");
    },
    // A record that needs review has an Inbox entry that opens its comparison.
    openReview: () => openView("inbox"),
  });
  const [inboxSelection, setInboxSelection] = useState<TriageSelection | null>(
    null,
  );
  const [inboxTarget, setInboxTarget] = useState<{
    reference: string;
    id: string;
    key: number;
  } | null>(null);
  const { sidebarCollapsed } = usePreferences();
  // The window opening, and a workspace switch, play the launch cascade; coming
  // back to the window does not.
  const workspaceRoot = useRef<HTMLDivElement>(null);
  const [launches, setLaunches] = useState(0);
  useEffect(() => {
    if (workspaceRoot.current) launch(workspaceRoot.current);
  }, [launches]);
  const [counts, setCounts] = useState<SidebarCounts | null>(null);
  const loadCounts = useRef(() => {});
  useEffect(() => {
    let active = true;
    loadCounts.current = () =>
      void countsClient
        .sidebar()
        .then((value) => {
          if (active) setCounts(value);
        })
        .catch(() => {});
    loadCounts.current();
    return () => {
      active = false;
    };
  }, []);
  const [graphOrigin, setGraphOrigin] = useState<string | null>(null);
  const [localGraphOrigin, setLocalGraphOrigin] = useState<string | null>(null);
  // A ticket's graph opened from its header or rail starts on its dependencies.
  const [graphDependencies, setGraphDependencies] = useState(false);
  const [workspaceGraphPlan, setWorkspaceGraphPlan] = useState<string | null>(
    null,
  );
  const [workspaceGraphOpen, setWorkspaceGraphOpen] = useState(false);
  // Once opened it stays mounted (hidden), so coming back restores its filters,
  // selection and viewport exactly as Back does.
  const [workspaceGraphMounted, setWorkspaceGraphMounted] = useState(false);
  // The only way to change the top-level view or the open graph: switching view
  // closes any graph, and opening a graph leaves the view as it was.
  // `keepGraph` only hides the graph so Back to graph can return to it.
  const navigate = (next: {
    view?: typeof view;
    graph?: string | null;
    keepGraph?: boolean;
  }) => {
    if (next.keepGraph) {
      setGraphOrigin(null);
      if (next.view) setViewState(next.view);
      return;
    }
    const graph = next.graph ?? null;
    if (graph === "__workspace__") setWorkspaceGraphMounted(true);
    setWorkspaceGraphOpen(graph === "__workspace__");
    setLocalGraphOrigin(graph && graph !== "__workspace__" ? graph : null);
    setGraphOrigin(graph);
    if (next.view) setViewState(next.view);
  };
  const keepGraph = useRef(false);
  const setView = (next: typeof view) =>
    navigate({ view: next, keepGraph: keepGraph.current });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteReference, setPaletteReference] = useState<string | null>(null);
  const [paletteScope, setPaletteScope] = useState<TicketCommandScope | null>(
    null,
  );
  const paletteReturn = useRef<HTMLElement | null>(null);
  const [capture, setCapture] = useState(false);
  // Capture has no trigger of its own, so closing it returns focus to whatever opened it.
  const captureReturn = useRef<HTMLElement | null>(null);
  const openCapture = (from?: HTMLElement | null) => {
    captureReturn.current =
      from ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    setCapture(true);
  };
  const closeCapture = () => {
    setCapture(false);
    const target = captureReturn.current;
    captureReturn.current = null;
    const active = document.activeElement;
    if (
      (!active || active === document.body) &&
      target?.isConnected &&
      !target.closest("[hidden], [inert]")
    )
      target.focus({ preventScroll: true });
  };
  // Capture is reachable from anywhere: Mod+Shift+N opens it without leaving the current view.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        openCapture();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [documentTarget, setDocumentTarget] = useState<{
    id: string;
    key: number;
  } | null>(null);
  const [documentReturn, setDocumentReturn] = useState<typeof view | null>(
    null,
  );
  // What a reader opened from a ticket returns to, named for its Back button.
  const [documentReturnLabel, setDocumentReturnLabel] = useState<string | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  // The status a group's Add action asked for; the sidebar's New ticket has none.
  const [createStatus, setCreateStatus] = useState<string | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  // C opens New ticket over the current view, unless typing or another
  // dialog or menu has the keys (P18).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (!matchesShortcut(event, "new-ticket")) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "input, textarea, select, [contenteditable], [role=dialog], [role=alertdialog], [role=menu], [role=listbox]",
        )
      )
        return;
      event.preventDefault();
      if (editingBlockedReason(workspaceProblem)) return;
      const focused = document.activeElement;
      createTriggerRef.current =
        focused instanceof HTMLButtonElement ? focused : null;
      setCreateStatus(undefined);
      setCreating(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workspaceProblem]);
  const workspace = useTicketWorkspace(setView, setCreating);
  const {
    projects,
    plans,
    setSelected,
    clearOpened,
    patchTicket,
    error,
    loading,
    revision,
    refresh,
    sourceHealth,
    verifiedCredentials,
    sourceHealthReadFailure,
    readSourceHealth,
    sourceEntries,
    sourceCatalogObservation,
    readSourceEntries,
    sourceConnectionsChanged,
    sourceRefresh,
    refreshSources,
    create,
    scope,
    navigation,
  } = workspace;
  // Workspace info excludes Trash. Join the existing Trash read before
  // treating an empty filtered list as a brand-new Workspace.
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(
    null,
  );
  // Whether the info has been read yet, whatever it said: until then nobody
  // knows if this Workspace is new.
  const [infoRead, setInfoRead] = useState(false);
  useEffect(() => {
    let live = true;
    void workspaceClient
      .info()
      .then(async (info) => {
        if (info.tickets === 0 && (await client.listTrash()).length > 0)
          return null;
        return info;
      })
      .then(
        (info) => {
          if (!live) return;
          setWorkspaceInfo(info);
          setInfoRead(true);
        },
        () => {
          if (!live) return;
          setWorkspaceInfo(null);
          setInfoRead(true);
        },
      );
    return () => {
      live = false;
    };
  }, [revision]);
  // Nothing but tickets could be missing: no other content, no failed read, no
  // filter that would hide one.
  const nothingElse =
    workspace.listKnown &&
    workspace.plansKnown &&
    !workspace.queryError &&
    !workspace.plansFailure &&
    workspaceInfo?.documents === 0 &&
    workspaceInfo.projects === 0 &&
    workspaceInfo.active_plans === 0 &&
    projects.length === 0 &&
    plans.length === 0 &&
    !error &&
    navigation.kind === "all" &&
    navigation.project === "all" &&
    !navigation.plan &&
    !workspace.query &&
    !workspace.status &&
    !workspace.tags.length &&
    !workspace.availability &&
    workspace.source === "all";
  const noTickets =
    workspaceInfo?.tickets === 0 &&
    !loading &&
    workspace.tickets.length === 0 &&
    workspace.opened.length === 0 &&
    (counts?.total ?? 0) === 0 &&
    (workspace.counts?.total ?? 0) === 0;
  // The first ticket reaches the info and the counts, and opens, before the
  // list has read it. So once it was created from the guide, the guide stays
  // until the list holds a ticket, and the list never shows "No tickets yet" in
  // between. A failed read gives up the wait.
  const [firstCreated, setFirstCreated] = useState(false);
  if (firstCreated && workspace.tickets.length > 0) setFirstCreated(false);
  const firstRun =
    nothingElse &&
    (noTickets ||
      (firstCreated &&
        workspace.tickets.length === 0 &&
        !workspace.refreshFailed));
  const createTicket = async (...args: Parameters<typeof create>) => {
    if (firstRun) setFirstCreated(true);
    try {
      return await create(...args);
    } catch (reason) {
      setFirstCreated(false);
      throw reason;
    }
  };
  // The guide is a page of its own: when the list holds the first ticket the
  // guide goes and the list arrives in its place, which `ViewRegion` plays as a
  // switch.
  const guideShown = firstRun && view === "tickets" && graphOrigin === null;
  // Before the guide or the list can be chosen, the list shows neither its
  // placeholders nor "No tickets yet": in a new Workspace the guide is the first
  // thing seen. A Workspace the info says has tickets, documents, projects or
  // Plans is known not to be new, so its list shows at once; a failed read gives
  // up the wait.
  const looksNew =
    workspaceInfo?.tickets === 0 &&
    workspaceInfo.documents === 0 &&
    workspaceInfo.projects === 0 &&
    workspaceInfo.active_plans === 0;
  const firstRunPending =
    view === "tickets" &&
    graphOrigin === null &&
    !firstRun &&
    workspace.tickets.length === 0 &&
    !workspace.queryError &&
    !workspace.plansFailure &&
    (!infoRead || (looksNew && !(workspace.listKnown && workspace.plansKnown)));
  const goTo = (target: GoTo) => {
    if ((target === "chats" || target === "automations") && !chat.enabled)
      return;
    if (target === "all" || target === "ready" || target === "trash") {
      scope(target);
      setView("tickets");
    } else openView(target);
  };
  function actionReference() {
    const focused =
      document.activeElement instanceof Element
        ? document.activeElement.closest<HTMLElement>(
            "[data-ticket-reference], [data-board-reference]",
          )
        : null;
    return (
      focused?.dataset.ticketReference ??
      focused?.dataset.boardReference ??
      (view === "tickets" ? workspace.selected : null)
    );
  }
  function openPalette(
    scope: TicketCommandScope | null = null,
    origin?: HTMLElement,
  ) {
    paletteReturn.current =
      origin ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    setPaletteReference(actionReference());
    setPaletteScope(scope);
    setPaletteOpen(true);
  }
  function openTicketUpdate() {
    if (workspace.selected) requestTicketUpdate(workspace.selected);
  }
  useCommandKeys(
    () => openPalette(),
    goTo,
    (event) => {
      const reference = actionReference();
      if (!reference) return false;
      const action = ticketCommandActions.find((action) =>
        matchesShortcut(event, action.shortcut),
      );
      if (action) {
        openPalette(action.scope);
        return true;
      }
      if (matchesShortcut(event, "ticket-copy-reference")) {
        void navigator.clipboard.writeText(reference);
        return true;
      }
      if (
        matchesShortcut(event, "ticket-update") &&
        editingBlockedReason(workspaceProblem) === null &&
        view === "tickets" &&
        workspace.selected === reference
      ) {
        openTicketUpdate();
        return true;
      }
      return false;
    },
  );
  useEffect(() => loadCounts.current(), [revision]);
  const openGraphItem = (node: GraphData["nodes"][number]) => {
    keepGraph.current = true;
    try {
      openGraphTarget(node);
    } finally {
      keepGraph.current = false;
    }
  };
  const openGraphTarget = (node: GraphData["nodes"][number]) => {
    setGraphOrigin(null);
    if (node.kind === "document") {
      setDocumentTarget({ id: node.id, key: Date.now() });
      setView("documents");
    } else if (node.kind === "plan") {
      scope("all", "all", node.id);
      setView("tickets");
    } else if (node.ticket_reference) {
      setSelected(node.ticket_reference);
      setView("tickets");
    }
  };
  // Writes made outside a ticket's page (the palette, bulk edits) report that
  // the Workspace changed, so an open ticket shows them at once. The report
  // moves the shared version, which reloads the list.
  const reportTicketChanged = useTicketChanged();
  // This sits above `TicketListSync`, so its report would not reach the list
  // row: show the returned Tickets in the list here, as the other write sites do.
  const reportChange = useCallback(
    (returned?: ReturnedTickets) => {
      for (const ticket of [returned ?? []].flat()) patchTicket(ticket);
      return reportTicketChanged(returned);
    },
    [patchTicket, reportTicketChanged],
  );
  const pendingSourceSetup =
    projectSource?.mode === "setup" ? projectSource : null;
  const scopedProject = projects.find((item) => item.id === navigation.project);
  const sourceProject = projects.find(
    (item) => item.id === projectSource?.projectId,
  );
  if (sourceProject?.archived && projectSource) {
    if (projectSource.mode === "review" && !projectSource.closing)
      setProjectSource({ ...projectSource, closing: true });
    if (
      projectSource.mode === "edit_remote" &&
      projectSource.exit !== "archived"
    )
      setProjectSource({ ...projectSource, exit: "archived" });
    if (projectSource.mode === "setup") setProjectSource(null);
  }
  const sourceRevision = JSON.stringify(
    sourceEntries.map(({ saved }) => [saved?.id, saved?.saved_at]),
  );
  function finishProjectSourceSetup(connection: string) {
    if (!pendingSourceSetup) return;
    void reportChange();
    setView(viewBeforeSettings);
    setProjectSource({
      mode: "review",
      projectId: pendingSourceSetup.projectId,
      resumed: true,
      connection,
    });
  }
  const bulk = useBulkEdit(reportChange);
  const discardChatWorkspace = () => {
    chat.replaceWorkspace?.();
    setSeenChatOpen(0);
    setSeenChatRequest(0);
    setChatWorkspace((generation) => generation + 1);
    setNewChatRequest(0);
  };
  // A restore or a download from Drive replaced the whole Workspace: the
  // selection, the opened pages and a failed bulk change describe the old one.
  // The report reloads the list through the shared version.
  const replaceWorkspace = async () => {
    setProjectSource(null);
    setSelected(null);
    clearOpened();
    bulk.reset();
    await workspaceReplaced();
    // After the reads are dropped, so the launch does not animate the old
    // Workspace's rows; the new ones arrive as their list loads. The list's own
    // read is not one of those, so rows it already began to animate are skipped
    // by the launch (arrive.ts).
    setLaunches((count) => count + 1);
  };
  const openNotifiedTicket = (reference: string) => {
    setInboxTarget(null);
    setSelected(reference);
    setView("tickets");
  };
  useReminderNotifications(openNotifiedTicket);
  const isMobile = useIsMobile();
  const { resolvePaletteFocus, resolveSettingsFocus } =
    useResponsiveNavigationFocus(isMobile, paletteReturn);
  /**
   * The run a ticket, the Inbox or a notification asked to see, opened by the
   * Automations page.
   */
  const [runTarget, setRunTarget] = useState<{
    id: string;
    key: number;
  } | null>(null);
  const openRun = (id: string) => {
    setRunTarget({ id, key: Date.now() });
    setView("automations");
  };
  useAutomationNotifications(chat.enabled, openNotifiedTicket, openRun);
  const hasWorkspaceBand = Boolean(workspaceProblem || recoveryNotices);
  const bandReserved = useBandContinuity(
    hasWorkspaceBand,
    contentPanel,
    JSON.stringify([
      view,
      workspace.selected,
      settingsSection,
      graphOrigin,
      navigation,
    ]),
  );
  const workspaceRetry = useRef<Promise<void> | null>(null);
  const retryWorkspace = () => {
    if (workspaceRetry.current) return workspaceRetry.current;
    const failed = getWorkspaceFailure();
    const attempt = (async () => {
      await recovery.flush();
      // sidebar_counts delivers due reminders in a write transaction: reads alone cannot prove recovery.
      setCounts(await countsClient.sidebar());
      clearWorkspaceFailure(failed);
      await refresh({ reportFailure: true });
    })();
    workspaceRetry.current = attempt;
    void attempt
      .finally(() => {
        if (workspaceRetry.current === attempt) workspaceRetry.current = null;
      })
      .catch(() => {});
    return attempt;
  };
  const workspaceBand = workspaceProblem ? (
    <WorkspaceBand onRetry={retryWorkspace} />
  ) : (
    recoveryNotices
  );
  const deferredWorkspaceLabel =
    !bandReserved && hasWorkspaceBand
      ? workspaceProblem
        ? workspaceMessages[workspaceProblem.problem]
        : "Legacy drafts need review. Files stay protected."
      : null;
  const showWorkspaceNotice = () => {
    const triggers = [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-workspace-notice]",
      ),
    ];
    (
      triggers.find((trigger) => trigger.getClientRects().length > 0) ??
      triggers.find((trigger) => !trigger.closest("[hidden]"))
    )?.click();
  };
  // The Ticket the Inbox selection is about, for the Inbox commands, and the
  // one the palette is acting on. Both share the open Ticket's read.
  const inboxReference =
    view === "inbox" && inboxSelection
      ? inboxSelection.kind === "entry"
        ? inboxSelection.entry.reference
        : inboxSelection.kind === "approval"
          ? (inboxSelection.chat.tickets[0]?.reference ??
            inboxSelection.chat.first_ticket)
          : null
      : null;
  // Undefined until read, null once the Ticket is gone.
  const inboxRecord = useTicket(inboxReference ?? null).value;
  const inboxTicket = inboxRecord ?? undefined;
  // Read only while the palette is open: a closed one has no use for it.
  const paletteTicket =
    useTicket(paletteOpen ? paletteReference : null).value ?? undefined;
  // Hidden views mount on their first visit, then stay to keep their state.
  const paletteMounted = useVisited(paletteOpen);
  const projectsShown = view === "projects" || view === "archived-projects";
  const projectsMounted = useVisited(projectsShown);
  const documentsMounted = useVisited(view === "documents" || capture);
  const chatsMounted = useVisited(view === "chats");
  return (
    // Runs open in the Automations page, which is there only while Chat is on.
    // Without it a run's Inbox entry opens its ticket instead.
    <RunNavigation value={chat.enabled ? openRun : null}>
      <ShellNavigation
        setup={{
          newTicket: (trigger) => {
            createTriggerRef.current = trigger;
            setCreateStatus(undefined);
            setCreating(true);
          },
          startChat: chat.enabled
            ? () => {
                setNewChatRequest((count) => count + 1);
                openView("chats");
              }
            : null,
          newTicketDisabledReason: createDisabledReason,
        }}
        graph={(id, options) => {
          // A ticket's graph opened from its header or rail starts on its
          // dependencies; anything else shows all connections.
          setGraphDependencies(options?.dependencies ?? false);
          setWorkspaceGraphPlan(options?.workspacePlan ?? null);
          navigate({ graph: options?.workspacePlan ? "__workspace__" : id });
        }}
        settings={(page) => {
          // Opening Settings starts on Appearance, so choose the page after.
          openView("settings");
          setSettingsSection(page);
        }}
      >
        <TicketNavigation.Provider
          value={(reference) => {
            setSelected(reference);
            setView("tickets");
          }}
        >
          <PlanNavigation.Provider
            value={(id) => {
              scope("all", "all", id);
              setView("tickets");
            }}
          >
            <ProjectNavigation.Provider
              value={(id) => {
                navigate({});
                scope("all", id);
              }}
            >
              <DocumentNavigation.Provider
                value={(id, backLabel) => {
                  if (view !== "documents") {
                    setDocumentReturn(view);
                    setDocumentReturnLabel(
                      backLabel ??
                        (view === "tickets" && workspace.selected
                          ? `Back to ${workspace.selected}`
                          : null),
                    );
                  }
                  setDocumentTarget({ id, key: Date.now() });
                  setView("documents");
                }}
              >
                <SourceActivityContext.Provider
                  value={{
                    refreshing:
                      sourceHealth.refreshing || sourceRefresh.running,
                    sources: sourceHealth.sources,
                    entries: sourceEntries,
                    catalogObservation: sourceCatalogObservation,
                    readCatalog: () => readSourceEntries().generation,
                    intervalSecs: sourceHealth.interval_secs ?? null,
                    openSettings: (connection) => {
                      openView("settings");
                      setSettingsSection(
                        connection ? `source-${connection}` : "ticket-sources",
                      );
                    },
                    refreshAll: () => refreshSources(),
                    verifiedCredentials,
                    healthReadFailure: sourceHealthReadFailure,
                    readHealth: readSourceHealth,
                  }}
                >
                  <SettingsStateProvider
                    active={view === "settings"}
                    onOpenPage={setSettingsSection}
                  >
                    <SidebarProvider open={!sidebarCollapsed}>
                      <StatusLineSpot>
                        <a
                          className="skip-link"
                          href="#main-content"
                          onClick={(event) => {
                            event.preventDefault();
                            document.getElementById("main-content")?.focus();
                          }}
                        >
                          Skip to content
                        </a>
                        <WindowBar />
                        <StatusLineRegion
                          host={{ current: contentPanel }}
                          notice={updateNotice}
                        >
                          <PageZoomStatus zoom={pageZoom} />
                          <NewPlanDialog
                            open={creatingPlan}
                            onOpenChange={setCreatingPlan}
                            refresh={refresh}
                            onCreated={(id) => scope("all", "all", id)}
                          />
                          {paletteMounted && (
                            <CommandPalette
                              pageZoom={pageZoom}
                              inboxCommands={
                                view === "inbox" && inboxSelection
                                  ? (() => {
                                      const entry =
                                        inboxSelection.kind === "entry"
                                          ? inboxSelection.entry
                                          : null;
                                      const chat =
                                        inboxSelection.kind === "approval"
                                          ? inboxSelection.chat
                                          : null;
                                      const reference =
                                        entry?.reference ??
                                        chat?.tickets[0]?.reference ??
                                        chat?.first_ticket;
                                      const ticketReason =
                                        editingBlockedReason(
                                          workspaceProblem,
                                        ) ??
                                        (!reference
                                          ? "This Chat has no linked Ticket."
                                          : null);
                                      const blocked =
                                        editingBlockedReason(workspaceProblem);
                                      const activeTicket = reference
                                        ? inboxTicket
                                        : undefined;
                                      const ticketActionReason =
                                        ticketReason ??
                                        ticketUnavailable(
                                          reference ? inboxRecord : undefined,
                                        );
                                      // A reminder is the person's own, so Trash does not block it.
                                      const reminderActionReason =
                                        ticketReason ??
                                        ticketUnavailable(
                                          reference ? inboxRecord : undefined,
                                          { allowTrashed: true },
                                        );
                                      const isReview =
                                        entry?.kind === "status" &&
                                        entry.to_value === "In review";
                                      const primaryReason = isReview
                                        ? (ticketActionReason ??
                                          (activeTicket?.status !== "In review"
                                            ? "This review is already resolved."
                                            : activeTicket.source?.ownership ===
                                                  "external" &&
                                                (activeTicket.source
                                                  .status_locked ||
                                                  !activeTicket.source.status_choices.includes(
                                                    "Done",
                                                  ))
                                              ? "The source does not allow moving this Ticket to Done."
                                              : null))
                                        : entry?.kind === "reminder"
                                          ? reminderActionReason
                                          : blocked;
                                      const primaryLabel = chat
                                        ? "Review in Chat"
                                        : entry?.kind === "reminder"
                                          ? "Clear reminder"
                                          : entry?.kind === "status" &&
                                              entry.to_value === "In review"
                                            ? "Move to Done"
                                            : "Mark read";
                                      return [
                                        {
                                          id: "inbox-primary" as const,
                                          label: primaryLabel,
                                          disabledReason: chat
                                            ? null
                                            : primaryReason,
                                          run: () =>
                                            requestInboxAction("primary"),
                                        },
                                        {
                                          id: "inbox-reply" as const,
                                          label: "Reply on this Ticket",
                                          disabledReason: ticketActionReason,
                                          run: () =>
                                            requestInboxAction("reply"),
                                        },
                                        {
                                          id: "inbox-remind" as const,
                                          label:
                                            entry?.kind === "reminder"
                                              ? "Snooze reminder"
                                              : "Remind me on this Ticket",
                                          disabledReason: reminderActionReason,
                                          run: () =>
                                            requestInboxAction("remind"),
                                        },
                                        {
                                          id: "inbox-read" as const,
                                          label: "Toggle Inbox read state",
                                          disabledReason: blocked,
                                          run: () => requestInboxAction("read"),
                                        },
                                        {
                                          id: "inbox-next" as const,
                                          label: "Next Inbox entry",
                                          disabledReason: null,
                                          run: () => requestInboxAction("next"),
                                        },
                                        {
                                          id: "inbox-previous" as const,
                                          label: "Previous Inbox entry",
                                          disabledReason: null,
                                          run: () =>
                                            requestInboxAction("previous"),
                                        },
                                      ];
                                    })()
                                  : null
                              }
                              writeUpdate={
                                view === "tickets" &&
                                workspace.selected === paletteReference &&
                                editingBlockedReason(workspaceProblem) === null
                                  ? openTicketUpdate
                                  : null
                              }
                              memoryTickets={workspace.tickets}
                              readyCount={counts?.ready ?? null}
                              automationCount={counts?.runs_needing_you ?? null}
                              {...{
                                attachmentCommands:
                                  view === "attachments" && graphOrigin === null
                                    ? attachmentCommands
                                    : null,
                                documentCommands:
                                  view === "documents" && graphOrigin === null
                                    ? documentCommands
                                    : null,
                              }}
                              currentPlan={navigation.plan || null}
                              workspaceGraphActive={
                                graphOrigin === "__workspace__"
                              }
                              createDisabledReason={createDisabledReason}
                              create={(kind) => {
                                if (editingBlockedReason(workspaceProblem))
                                  return;
                                if (kind === "ticket") {
                                  createTriggerRef.current =
                                    paletteReturn.current instanceof
                                    HTMLButtonElement
                                      ? paletteReturn.current
                                      : null;
                                  setCreateStatus(undefined);
                                  setCreating(true);
                                } else if (kind === "plan") {
                                  setCreatingPlan(true);
                                } else if (kind === "capture")
                                  openCapture(paletteReturn.current);
                                else {
                                  setNewChatRequest((count) => count + 1);
                                  openView("chats");
                                }
                              }}
                              initialTicket={
                                paletteTicket ??
                                workspace.tickets.find(
                                  (ticket) =>
                                    ticket.reference === paletteReference,
                                ) ??
                                null
                              }
                              reference={paletteReference}
                              initialScope={paletteScope}
                              projects={projects}
                              plans={plans}
                              refresh={reportChange}
                              open={paletteOpen}
                              returnFocus={paletteReturn}
                              resolveReturnFocus={resolvePaletteFocus}
                              onOpenChange={setPaletteOpen}
                              go={goTo}
                              chatsEnabled={chat.enabled}
                              workspaceNotice={
                                deferredWorkspaceLabel
                                  ? {
                                      label: "Review workspace notice",
                                      run: showWorkspaceNotice,
                                    }
                                  : null
                              }
                              ticket={(reference) => {
                                setSelected(reference);
                                setView("tickets");
                              }}
                            />
                          )}
                        </StatusLineRegion>
                        <div
                          ref={workspaceRoot}
                          className={
                            view === "settings"
                              ? "workspace settings-open"
                              : "workspace"
                          }
                        >
                          {view === "settings" ? (
                            <SettingsNav
                              resolveReturnFocus={resolveSettingsFocus}
                              selected={settingsSection}
                              onSelect={setSettingsSection}
                              origin={VIEW_NAMES[viewBeforeSettings]}
                              onBack={() => {
                                returnToSettingsEntry.current = true;
                                setProjectSource(null);
                                setView(viewBeforeSettings);
                              }}
                            />
                          ) : (
                            <WorkspaceSidebar
                              onOpenPalette={(origin) =>
                                openPalette(null, origin)
                              }
                              createDisabledReason={createDisabledReason}
                              counts={counts}
                              hasTickets={
                                workspace.tickets.length > 0 ||
                                (counts?.total ?? 0) > 0
                              }
                              view={view}
                              workspaceGraphOpen={
                                graphOrigin === "__workspace__"
                              }
                              setView={openView}
                              projects={projects}
                              plans={plans}
                              scope={(...args) => {
                                // A sidebar view always shows its list, not an open graph.
                                navigate({});
                                scope(...args);
                              }}
                              navigation={navigation}
                              onError={workspace.setError}
                              setCreating={(value) => {
                                if (value) setCreateStatus(undefined);
                                setCreating(value);
                              }}
                              createTriggerRef={createTriggerRef}
                            />
                          )}
                          <main
                            id="main-content"
                            tabIndex={-1}
                            className="content-panel"
                            ref={setContentPanel}
                          >
                            <OverlayBoundary element={contentPanel}>
                              <BandSlot open={bandReserved}>
                                {workspaceBand}
                              </BandSlot>
                              {deferredWorkspaceLabel && (
                                <span role="status" className="sr-only">
                                  {deferredWorkspaceLabel}
                                </span>
                              )}
                              {/* Views without a pane of their own post here. */}
                              <StatusLineRegion>
                                <ShellSlotProvider
                                  notice={
                                    deferredWorkspaceLabel ? (
                                      <WorkspaceNotice
                                        label={deferredWorkspaceLabel}
                                      >
                                        {workspaceBand}
                                      </WorkspaceNotice>
                                    ) : null
                                  }
                                  nav={
                                    isMobile &&
                                    view !== "settings" && (
                                      <NarrowNav
                                        onOpenPalette={(origin) =>
                                          openPalette(null, origin)
                                        }
                                        waitingChats={chat.overview.needs_you}
                                        waitingRuns={
                                          chat.enabled
                                            ? (counts?.runs_needing_you ?? 0)
                                            : 0
                                        }
                                        unreadInbox={counts?.unread_inbox ?? 0}
                                      />
                                    )
                                  }
                                  crumb={
                                    (workspaceGraphOpen || localGraphOrigin) &&
                                    graphOrigin === null && (
                                      <ReturnCrumb
                                        origin={
                                          localGraphOrigin
                                            ? "Graph"
                                            : "Workspace graph"
                                        }
                                        label={
                                          localGraphOrigin
                                            ? "Back to graph"
                                            : "Back to workspace graph"
                                        }
                                        onReturn={() =>
                                          setGraphOrigin(
                                            localGraphOrigin ?? "__workspace__",
                                          )
                                        }
                                      />
                                    )
                                  }
                                >
                                  {error && (
                                    // A local preference could not be saved: a failure
                                    // on the status line, until dismissed or a later
                                    // save works; a list load never clears it.
                                    <PreferenceFailure
                                      message={error}
                                      onDismiss={() => workspace.setError("")}
                                    />
                                  )}
                                  <CreateTicketDialog
                                    key={`new-ticket:${recoveryGeneration}`}
                                    open={creating}
                                    onOpenChange={setCreating}
                                    triggerRef={createTriggerRef}
                                    navigation={navigation}
                                    {...(createStatus && {
                                      initialStatus: createStatus,
                                    })}
                                    projects={projects}
                                    plans={plans}
                                    create={createTicket}
                                  />
                                  {projectSource?.mode === "review" && (
                                    <ConnectProjectSource
                                      projectId={projectSource.projectId}
                                      closing={projectSource.closing ?? false}
                                      {...(sourceProject?.remote && {
                                        projectRemote: sourceProject.remote,
                                      })}
                                      {...(projectSource.connection && {
                                        connection: projectSource.connection,
                                      })}
                                      resumeAfterSetup={
                                        projectSource.resumed ?? false
                                      }
                                      onClose={() => setProjectSource(null)}
                                      onSetup={setupProjectSource}
                                      onConnected={() => void reportChange()}
                                      fallbackFocus={() => contentPanel}
                                      {...(sourceProject && {
                                        onEditRemote: () =>
                                          setProjectSource({
                                            mode: "edit_remote",
                                            projectId: sourceProject.id,
                                            opening: Symbol(),
                                          }),
                                      })}
                                    />
                                  )}
                                  {projectSource?.mode === "edit_remote" &&
                                    sourceProject && (
                                      <ProjectFormDialog
                                        project={sourceProject}
                                        open={!projectSource.exit}
                                        resolveReturnFocus={() =>
                                          projectSource.exit === "archived"
                                            ? contentPanel
                                            : null
                                        }
                                        onOpenChange={(open) =>
                                          !open &&
                                          setProjectSource((current) =>
                                            current === projectSource
                                              ? { ...current, exit: "close" }
                                              : current,
                                          )
                                        }
                                        onSaved={(project) => {
                                          void reportChange();
                                          if (project.remote)
                                            setProjectSource((current) =>
                                              current?.mode === "edit_remote" &&
                                              current.opening ===
                                                projectSource.opening &&
                                              current.exit !== "archived"
                                                ? { ...current, exit: "review" }
                                                : current,
                                            );
                                        }}
                                        onExitComplete={() =>
                                          setProjectSource((current) => {
                                            if (
                                              current?.mode !== "edit_remote" ||
                                              current.opening !==
                                                projectSource.opening
                                            )
                                              return current;
                                            return current.exit === "review"
                                              ? {
                                                  mode: "review",
                                                  projectId: current.projectId,
                                                }
                                              : null;
                                          })
                                        }
                                      />
                                    )}
                                  <ViewRegion
                                    page={`${view}:${graphOrigin ?? ""}:${guideShown ? "first-run" : firstRunPending ? "pending" : ""}`}
                                  >
                                    {view === "settings" &&
                                      graphOrigin === null && (
                                        <SettingsView
                                          selected={settingsSection}
                                          onSelect={setSettingsSection}
                                          onRestore={replaceWorkspace}
                                          onWorkspaceReplaced={
                                            discardChatWorkspace
                                          }
                                          onSourcesChanged={
                                            sourceConnectionsChanged
                                          }
                                          onProjectLinked={(
                                            projectId,
                                            connection,
                                          ) => {
                                            void reportChange();
                                            reviewProjectSource(
                                              projectId,
                                              connection,
                                            );
                                          }}
                                          {...(pendingSourceSetup && {
                                            projectSourceSetup:
                                              pendingSourceSetup,
                                            onProjectSourceSaved:
                                              finishProjectSourceSetup,
                                            onProjectSourceCancel: () => {
                                              setProjectSource(null);
                                              setView(viewBeforeSettings);
                                            },
                                          })}
                                        />
                                      )}
                                    {view === "attachments" &&
                                      graphOrigin === null && (
                                        <AttachmentLibrary
                                          onCommandsChange={
                                            setAttachmentCommands
                                          }
                                        />
                                      )}
                                    {projectsMounted && (
                                      <div
                                        className="management-host"
                                        hidden={
                                          !projectsShown || graphOrigin !== null
                                        }
                                      >
                                        <Projects
                                          projects={projects}
                                          archived={
                                            view === "archived-projects"
                                          }
                                          onArchivedChange={(archived) =>
                                            setView(
                                              archived
                                                ? "archived-projects"
                                                : "projects",
                                            )
                                          }
                                          loading={loading}
                                          onChange={
                                            workspace.refreshCurrentScope
                                          }
                                          onProjectCommitted={
                                            workspace.patchProject
                                          }
                                          onConnectSource={reviewProjectSource}
                                          onOpenTickets={(item) => {
                                            navigate({});
                                            scope("all", item.id);
                                          }}
                                          onShowUnassigned={() => {
                                            navigate({});
                                            scope("all", "unlinked");
                                          }}
                                        />
                                      </div>
                                    )}
                                    {(view === "plans" ||
                                      view === "archived-plans") &&
                                      graphOrigin === null && (
                                        <PlanList
                                          plans={plans}
                                          known={workspace.plansKnown}
                                          failure={workspace.plansFailure}
                                          retry={workspace.refreshPlans}
                                          projects={projects}
                                          onTicket={(reference) => {
                                            setSelected(reference);
                                            setView("tickets");
                                          }}
                                          archived={view === "archived-plans"}
                                          onOpen={(id) =>
                                            scope("all", "all", id)
                                          }
                                          onArchivedChange={(archived) =>
                                            setView(
                                              archived
                                                ? "archived-plans"
                                                : "plans",
                                            )
                                          }
                                          refresh={refresh}
                                        />
                                      )}
                                    {documentsMounted && (
                                      <div
                                        className="context-view-wrapper"
                                        hidden={
                                          view !== "documents" ||
                                          graphOrigin !== null
                                        }
                                      >
                                        <Documents
                                          onCommandsChange={setDocumentCommands}
                                          key={`documents:${recoveryGeneration}`}
                                          active={view === "documents"}
                                          listRequest={documentListRequest}
                                          target={documentTarget}
                                          backLabel={
                                            (documentReturn &&
                                              documentReturnLabel) ||
                                            "Back to Documents"
                                          }
                                          capture={capture}
                                          onCapture={() => openCapture()}
                                          currentTicket={
                                            view === "tickets"
                                              ? workspace.selected
                                              : null
                                          }
                                          onOpenPlan={(id) => {
                                            // Leaving through a link ends the return trip.
                                            setDocumentReturn(null);
                                            scope("all", "all", id);
                                            setView("tickets");
                                          }}
                                          onOpenTicket={(reference) => {
                                            setDocumentReturn(null);
                                            setSelected(reference);
                                            setView("tickets");
                                          }}
                                          onDocumentClose={() => {
                                            if (documentReturn) {
                                              setView(documentReturn);
                                              setDocumentReturn(null);
                                            }
                                          }}
                                          onCaptureClose={closeCapture}
                                        />
                                      </div>
                                    )}
                                    {workspaceGraphMounted && (
                                      <div
                                        className="context-view-wrapper"
                                        hidden={graphOrigin !== "__workspace__"}
                                      >
                                        <WorkspaceGraph
                                          projects={projects}
                                          planId={workspaceGraphPlan}
                                          active={
                                            graphOrigin === "__workspace__"
                                          }
                                          revision={revision}
                                          onBack={() => {
                                            setGraphOrigin(null);
                                            setWorkspaceGraphOpen(false);
                                          }}
                                          onFocus={(id) => {
                                            // From the workspace: all connections.
                                            setGraphDependencies(false);
                                            setLocalGraphOrigin(id);
                                            setGraphOrigin(id);
                                          }}
                                          onOpen={openGraphItem}
                                        />
                                      </div>
                                    )}
                                    {localGraphOrigin && (
                                      <div
                                        className="context-view-wrapper"
                                        hidden={
                                          graphOrigin !== localGraphOrigin
                                        }
                                      >
                                        <ContextGraph
                                          key={`${localGraphOrigin}:${graphDependencies}`}
                                          active={
                                            graphOrigin === localGraphOrigin
                                          }
                                          origin={localGraphOrigin}
                                          dependencies={graphDependencies}
                                          revision={revision}
                                          projects={projects}
                                          plans={plans}
                                          {...(workspaceGraphOpen && {
                                            originLabel: "Workspace graph",
                                          })}
                                          onBack={(origin) => {
                                            setLocalGraphOrigin(null);
                                            if (workspaceGraphOpen)
                                              setGraphOrigin("__workspace__");
                                            else if (origin)
                                              openGraphItem(origin);
                                            else setGraphOrigin(null);
                                          }}
                                          onOpen={openGraphItem}
                                          onOpenTicket={(reference) => {
                                            keepGraph.current = true;
                                            try {
                                              setGraphOrigin(null);
                                              setSelected(reference);
                                              setView("tickets");
                                            } finally {
                                              keepGraph.current = false;
                                            }
                                          }}
                                        />
                                      </div>
                                    )}
                                    {chat.enabled && chatsMounted && (
                                      <div
                                        className="context-view-wrapper"
                                        hidden={
                                          view !== "chats" ||
                                          graphOrigin !== null
                                        }
                                      >
                                        <ChatsView
                                          key={chatWorkspace}
                                          newChatRequest={newChatRequest}
                                          projects={projects}
                                        />
                                      </div>
                                    )}
                                    {chat.enabled && view === "automations" && (
                                      <div
                                        className="context-view-wrapper"
                                        hidden={graphOrigin !== null}
                                      >
                                        <AutomationsView
                                          openRun={runTarget}
                                          onRunOpened={() => setRunTarget(null)}
                                        />
                                      </div>
                                    )}
                                    <TicketCommandContext.Provider
                                      value={(scope, reference) => {
                                        paletteReturn.current =
                                          document.activeElement instanceof
                                          HTMLElement
                                            ? document.activeElement
                                            : null;
                                        setPaletteReference(reference);
                                        setPaletteScope(scope);
                                        setPaletteOpen(true);
                                      }}
                                    >
                                      {guideShown && (
                                        <FirstRunGuide
                                          disabledReason={createDisabledReason}
                                          onCreate={(trigger) => {
                                            createTriggerRef.current = trigger;
                                            setCreateStatus(undefined);
                                            setCreating(true);
                                          }}
                                        />
                                      )}
                                      <TicketListSync value={patchTicket}>
                                        <InboxTriageProvider
                                          active={view === "inbox"}
                                          onSelectionChange={setInboxSelection}
                                        >
                                          <TicketWorkspaceView
                                            key={`tickets:${recoveryGeneration}`}
                                            workspace={workspace}
                                            bulk={bulk}
                                            projectNotice={
                                              !scopedProject?.archived && (
                                                <ProjectRemoteNote
                                                  project={scopedProject}
                                                  sourceRevision={
                                                    sourceRevision
                                                  }
                                                  onConnectSource={
                                                    reviewProjectSource
                                                  }
                                                  onProjectChange={() =>
                                                    void reportChange()
                                                  }
                                                />
                                              )
                                            }
                                            hidden={
                                              ((firstRun || firstRunPending) &&
                                                view === "tickets") ||
                                              (view !== "tickets" &&
                                                view !== "inbox") ||
                                              graphOrigin !== null
                                            }
                                            inboxTarget={inboxTarget}
                                            // The Inbox is a triage split: entries open
                                            // beside it, without leaving the view (S6).
                                            {...(view === "inbox" && {
                                              inbox: (
                                                <Inbox
                                                  revision={revision}
                                                  selected={workspace.selected}
                                                  onBrowse={() =>
                                                    setView("tickets")
                                                  }
                                                  select={(
                                                    reference,
                                                    noteId,
                                                  ) => {
                                                    setInboxTarget(
                                                      noteId && reference
                                                        ? {
                                                            reference,
                                                            id: noteId,
                                                            key: Date.now(),
                                                          }
                                                        : null,
                                                    );
                                                    setSelected(reference);
                                                  }}
                                                />
                                              ),
                                            })}
                                            onCreate={(trigger, status) => {
                                              createTriggerRef.current =
                                                trigger;
                                              setCreateStatus(status);
                                              setCreating(true);
                                            }}
                                          />
                                        </InboxTriageProvider>
                                      </TicketListSync>
                                    </TicketCommandContext.Provider>
                                  </ViewRegion>
                                </ShellSlotProvider>
                              </StatusLineRegion>
                            </OverlayBoundary>
                          </main>
                        </div>
                      </StatusLineSpot>
                    </SidebarProvider>
                  </SettingsStateProvider>
                </SourceActivityContext.Provider>
              </DocumentNavigation.Provider>
            </ProjectNavigation.Provider>
          </PlanNavigation.Provider>
        </TicketNavigation.Provider>
      </ShellNavigation>
    </RunNavigation>
  );
}

/**
 * A preference that could not be saved, as a failure on the status line of
 * the view (P6): it stays until the person dismisses it or a later save
 * works, which unmounts this and takes the line away.
 */
function PreferenceFailure({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const line = useStatusLine();
  const dismissed = useRef(onDismiss);
  useEffect(() => {
    dismissed.current = onDismiss;
  });
  useEffect(() => {
    line.show({
      tone: "error",
      message,
      onDismiss: () => dismissed.current(),
    });
    return () => line.dismiss();
  }, [line, message]);
  return null;
}

/** The shell's two ways out of a view: a context graph, and one Settings page. */
function ShellNavigation({
  graph,
  settings,
  setup,
  children,
}: {
  graph: ContextType<typeof ContextGraphNavigation>;
  settings: (page: SettingsPageId) => void;
  /** What Set up ticketd starts outside Settings. */
  setup: SetupActions;
  children: ReactNode;
}) {
  return (
    <SettingsNavigation.Provider value={settings}>
      <SetupActionsContext.Provider value={setup}>
        <ContextGraphNavigation.Provider value={graph}>
          {children}
        </ContextGraphNavigation.Provider>
      </SetupActionsContext.Provider>
    </SettingsNavigation.Provider>
  );
}

import {
  TicketCommandContext,
  ticketCommandActions,
  type TicketCommandScope,
} from "@/lib/ticket-command-actions";
import { CommandPalette } from "./CommandPalette";
import { useCommandKeys, type GoTo } from "./use-command-keys";
import {
  ContextGraphNavigation,
  DocumentNavigation,
  PlanNavigation,
  ProjectNavigation,
} from "@/features/documents/navigation";
import { ContextGraph } from "@/features/documents/ContextGraph";
import { WorkspaceGraph } from "@/features/documents/WorkspaceGraph";
import { Documents } from "@/features/documents/Documents";
import { AttachmentLibrary } from "@/features/attachments/AttachmentLibrary";
import type { SettingsPageId } from "@/features/settings/settings-sections";
import { SettingsStateProvider } from "@/features/settings/settings-state";
import { type ContextGraph as GraphData } from "@/lib/api/client";
import { countsClient, type SidebarCounts } from "@/lib/api/counts";
import { InboxAttentionProvider } from "@/features/tickets/inbox-attention";
import { Inbox } from "@/features/tickets/Inbox";
import { CreateTicketDialog } from "@/features/tickets/CreateTicketDialog";
import { useTicketWorkspace } from "@/features/tickets/useTicketWorkspace";
import { useBulkEdit } from "@/features/tickets/useBulkEdit";
import { TicketWorkspaceView } from "@/features/tickets/TicketWorkspaceView";
import {
  WorkspaceSidebar,
  type View,
} from "@/components/layout/WorkspaceSidebar";
import { SettingsView } from "@/features/settings/SettingsView";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { useReminderNotifications } from "@/features/tickets/useReminderNotifications";
import { usePreferences, useThemeSync } from "@/lib/preferences";
import { useInputModality } from "@/lib/input-modality";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ReturnCrumb, ShellSlotProvider } from "@/components/ui/list-header";
import { NarrowNav } from "@/components/layout/NarrowNav";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OverlayBoundary } from "@/components/ui/overlay-boundary";
import { WindowBar } from "@/components/layout/WindowBar";
import { StatusLineRegion } from "@/components/ui/status-line";
import { NewPlanDialog } from "@/features/plans/NewPlanDialog";
import { PlanList } from "@/features/plans/PlanList";
import { Projects } from "@/features/projects/Projects";
import {
  useEffect,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
} from "react";
import { matchesShortcut } from "@/lib/shortcuts";
import {
  useWorkspaceChangePoll,
  WorkspaceChangeProvider,
} from "@/lib/workspace-change";
import { useIsMobile } from "@/hooks/use-mobile";
import { SourceActivityContext } from "@/features/tickets/source-activity";
import { ExitDialog } from "@/features/sync/ExitDialog";
import { SyncStatusProvider } from "@/features/sync/SyncStatusProvider";
import { useSyncNavigation } from "@/features/sync/sync-status";
import { TicketNavigation } from "@/features/tickets/navigation";
import { SettingsNavigation } from "@/lib/settings-navigation";
import {
  useDraftRecovery,
  useDraftRecoveryGeneration,
  useDraftRecoveryNotices,
} from "@/lib/draft-recovery-context";
import { useStatusLine } from "@/components/ui/use-status-line";
import { WorkspaceBand } from "./WorkspaceBand";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { AutomationsView } from "@/features/automations/AutomationsView";
import { RunNavigation } from "@/features/automations/navigation";
import { useAutomationNotifications } from "@/features/automations/useAutomationNotifications";
import { ChatsView } from "@/features/chats/ChatsView";
import { useChatFeature } from "@/features/chats/use-chats";

/** Each top-level view by name, for "Back to …" (Settings returns to it). */
const VIEW_NAMES = {
  tickets: "tickets",
  projects: "Projects",
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
    <WorkspaceChangeProvider value={useWorkspaceChangePoll()}>
      {/* One tooltip delay for the whole app (DESIGN.md section 4). */}
      <TooltipProvider>
        <SyncStatusProvider>
          <ChatProvider>
            <InboxAttentionProvider>
              <AppContent />
            </InboxAttentionProvider>
          </ChatProvider>
          <ExitDialog />
        </SyncStatusProvider>
      </TooltipProvider>
    </WorkspaceChangeProvider>
  );
}

function AppContent() {
  const recoveryGeneration = useDraftRecoveryGeneration();
  const recoveryNotices = useDraftRecoveryNotices();
  const workspaceProblem = useWorkspaceState();
  const createDisabledReason =
    workspaceProblem?.problem === "workspace_read_only"
      ? "The workspace is read-only"
      : editingBlockedReason(workspaceProblem);
  const recovery = useDraftRecovery();
  const [view, setViewState] = useState<View>("tickets");
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
  const [settingsSection, setSettingsSection] =
    useState<SettingsPageId>("appearance");
  useThemeSync();
  useInputModality();
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
  const [documentListRequest, setDocumentListRequest] = useState(0);
  const [creatingPlan, setCreatingPlan] = useState(false);
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
      setSettingsSection("appearance");
    }
    setView(next);
  };
  useSyncNavigation({
    openSettings: () => {
      openView("settings");
      setSettingsSection("google-drive");
    },
    // A record that needs review has an Inbox entry that opens its comparison.
    openReview: () => openView("inbox"),
  });
  const [inboxTarget, setInboxTarget] = useState<{
    reference: string;
    id: string;
    key: number;
  } | null>(null);
  const { sidebarCollapsed } = usePreferences();
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
    window.setTimeout(() => {
      if (target?.isConnected) target.focus();
    }, 0);
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
    setDetails,
    error,
    loading,
    revision,
    refresh,
    sourceHealth,
    sourceEntries,
    sourceRefresh,
    refreshSources,
    create,
    scope,
    navigation,
  } = workspace;
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
  function openPalette(scope: TicketCommandScope | null = null) {
    paletteReturn.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setPaletteReference(actionReference());
    setPaletteScope(scope);
    setPaletteOpen(true);
  }
  function openTicketUpdate() {
    const composer = document.querySelector<HTMLElement>(
      '.detail-content:not([hidden]) [aria-label="Write an update"]',
    );
    const idle = composer?.querySelector<HTMLButtonElement>(
      ".activity-composer-idle",
    );
    if (idle) idle.click();
    else
      composer
        ?.querySelector<HTMLElement>('[role="textbox"], textarea')
        ?.focus();
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
  const bulk = useBulkEdit(refresh);
  const openNotifiedTicket = (reference: string) => {
    setInboxTarget(null);
    setSelected(reference);
    setView("tickets");
  };
  useReminderNotifications(openNotifiedTicket);
  const isMobile = useIsMobile();
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
  return (
    // Runs open in the Automations page, which is there only while Chat is on.
    // Without it a run's Inbox entry opens its ticket instead.
    <RunNavigation value={chat.enabled ? openRun : null}>
      <ShellNavigation
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
                    intervalSecs: sourceHealth.interval_secs ?? null,
                    openSettings: () => {
                      openView("settings");
                      setSettingsSection("source-github");
                    },
                    openSourceSettings: (provider) => {
                      openView("settings");
                      setSettingsSection(`source-${provider}`);
                    },
                    refreshAll: () => refreshSources(),
                  }}
                >
                  <SettingsStateProvider
                    active={view === "settings"}
                    onOpenPage={setSettingsSection}
                  >
                    <SidebarProvider open={!sidebarCollapsed}>
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
                      <StatusLineRegion host={{ current: contentPanel }}>
                        <NewPlanDialog
                          open={creatingPlan}
                          onOpenChange={setCreatingPlan}
                          refresh={refresh}
                          onCreated={(id) => scope("all", "all", id)}
                        />
                        <CommandPalette
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
                          currentPlan={navigation.plan || null}
                          workspaceGraphActive={graphOrigin === "__workspace__"}
                          createDisabledReason={createDisabledReason}
                          create={(kind) => {
                            if (editingBlockedReason(workspaceProblem)) return;
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
                            workspace.details[paletteReference ?? ""] ??
                            workspace.tickets.find(
                              (ticket) => ticket.reference === paletteReference,
                            ) ??
                            null
                          }
                          reference={paletteReference}
                          initialScope={paletteScope}
                          projects={projects}
                          plans={plans}
                          refresh={async () => {
                            await refresh();
                          }}
                          open={paletteOpen}
                          returnFocus={paletteReturn}
                          onOpenChange={setPaletteOpen}
                          go={goTo}
                          chatsEnabled={chat.enabled}
                          ticket={(reference) => {
                            setSelected(reference);
                            setView("tickets");
                          }}
                        />
                      </StatusLineRegion>
                      <div
                        className={
                          view === "settings"
                            ? "workspace settings-open"
                            : "workspace"
                        }
                      >
                        {view === "settings" ? (
                          <SettingsNav
                            selected={settingsSection}
                            onSelect={setSettingsSection}
                            origin={VIEW_NAMES[viewBeforeSettings]}
                            onBack={() => {
                              returnToSettingsEntry.current = true;
                              setView(viewBeforeSettings);
                            }}
                          />
                        ) : (
                          <WorkspaceSidebar
                            onOpenPalette={() => openPalette()}
                            createDisabledReason={createDisabledReason}
                            counts={counts}
                            hasTickets={
                              workspace.tickets.length > 0 ||
                              (counts?.total ?? 0) > 0
                            }
                            view={view}
                            workspaceGraphOpen={graphOrigin === "__workspace__"}
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
                            <WorkspaceBand
                              onRetry={() => {
                                recovery.retry();
                                void refresh({ reportFailure: true });
                              }}
                            />
                            {/* At most one band: a workspace failure outranks
                              the legacy-draft review. */}
                            {!workspaceProblem && recoveryNotices}
                            {/* Views without a pane of their own post here. */}
                            <StatusLineRegion>
                              <ShellSlotProvider
                                nav={
                                  isMobile &&
                                  view !== "settings" && (
                                    <NarrowNav
                                      onOpenPalette={() => openPalette()}
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
                                  create={create}
                                />
                                {view === "settings" &&
                                  graphOrigin === null && (
                                    <SettingsView
                                      selected={settingsSection}
                                      onSelect={setSettingsSection}
                                      onOpenInbox={() => setView("inbox")}
                                      onRestore={async () => {
                                        setSelected(null);
                                        setDetails({});
                                        bulk.reset();
                                        await refresh();
                                      }}
                                    />
                                  )}
                                {view === "attachments" &&
                                  graphOrigin === null && <AttachmentLibrary />}
                                {
                                  <div
                                    className="management-host"
                                    hidden={
                                      view !== "projects" ||
                                      graphOrigin !== null
                                    }
                                  >
                                    <Projects
                                      projects={projects}
                                      loading={loading}
                                      onChange={refresh}
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
                                }
                                {(view === "plans" ||
                                  view === "archived-plans") &&
                                  graphOrigin === null && (
                                    <PlanList
                                      plans={plans}
                                      projects={projects}
                                      onTicket={(reference) => {
                                        setSelected(reference);
                                        setView("tickets");
                                      }}
                                      archived={view === "archived-plans"}
                                      onOpen={(id) => scope("all", "all", id)}
                                      onArchivedChange={(archived) =>
                                        setView(
                                          archived ? "archived-plans" : "plans",
                                        )
                                      }
                                      refresh={refresh}
                                    />
                                  )}
                                <div
                                  className="context-view-wrapper"
                                  hidden={
                                    view !== "documents" || graphOrigin !== null
                                  }
                                >
                                  <Documents
                                    key={`documents:${recoveryGeneration}`}
                                    active={view === "documents"}
                                    listRequest={documentListRequest}
                                    target={documentTarget}
                                    backLabel={
                                      (documentReturn && documentReturnLabel) ||
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
                                {workspaceGraphMounted && (
                                  <div
                                    className="context-view-wrapper"
                                    hidden={graphOrigin !== "__workspace__"}
                                  >
                                    <WorkspaceGraph
                                      planId={workspaceGraphPlan}
                                      active={graphOrigin === "__workspace__"}
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
                                    hidden={graphOrigin !== localGraphOrigin}
                                  >
                                    <ContextGraph
                                      key={`${localGraphOrigin}:${graphDependencies}`}
                                      active={graphOrigin === localGraphOrigin}
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
                                        else if (origin) openGraphItem(origin);
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
                                {chat.enabled && (
                                  <div
                                    className="context-view-wrapper"
                                    hidden={
                                      view !== "chats" || graphOrigin !== null
                                    }
                                  >
                                    <ChatsView
                                      newChatRequest={newChatRequest}
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
                                  <TicketWorkspaceView
                                    key={`tickets:${recoveryGeneration}`}
                                    workspace={workspace}
                                    bulk={bulk}
                                    hidden={
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
                                          onBrowse={() => setView("tickets")}
                                          select={(reference, noteId) => {
                                            setInboxTarget(
                                              noteId
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
                                      createTriggerRef.current = trigger;
                                      setCreateStatus(status);
                                      setCreating(true);
                                    }}
                                  />
                                </TicketCommandContext.Provider>
                              </ShellSlotProvider>
                            </StatusLineRegion>
                          </OverlayBoundary>
                        </main>
                      </div>
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
  children,
}: {
  graph: ContextType<typeof ContextGraphNavigation>;
  settings: (page: SettingsPageId) => void;
  children: ReactNode;
}) {
  return (
    <SettingsNavigation.Provider value={settings}>
      <ContextGraphNavigation.Provider value={graph}>
        {children}
      </ContextGraphNavigation.Provider>
    </SettingsNavigation.Provider>
  );
}

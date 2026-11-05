import {
  ContextGraphNavigation,
  DocumentNavigation,
  PlanNavigation,
} from "@/features/documents/navigation";
import { ContextGraph } from "@/features/documents/ContextGraph";
import { WorkspaceGraph } from "@/features/documents/WorkspaceGraph";
import { Documents } from "@/features/documents/Documents";
import type { SettingsCardKey } from "@/features/settings/settings-sections";
import { type ContextGraph as GraphData } from "@/lib/api/client";
import { countsClient, type SidebarCounts } from "@/lib/api/counts";
import { Inbox } from "@/features/tickets/Inbox";
import { CreateTicketDialog } from "@/features/tickets/CreateTicketDialog";
import { useTicketWorkspace } from "@/features/tickets/useTicketWorkspace";
import { useBulkEdit } from "@/features/tickets/useBulkEdit";
import { TicketWorkspaceView } from "@/features/tickets/TicketWorkspaceView";
import { WorkspaceSidebar } from "@/components/layout/WorkspaceSidebar";
import { SettingsView } from "@/features/settings/SettingsView";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { useReminderNotifications } from "@/features/tickets/useReminderNotifications";
import { useThemeSync } from "@/lib/preferences";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Menu } from "lucide-react";
import { PlanList } from "@/features/plans/PlanList";
import { Projects } from "@/features/projects/Projects";
import { useEffect, useRef, useState } from "react";
import {
  useOnWorkspaceChange,
  useWorkspaceChangePoll,
  WorkspaceChangeProvider,
} from "@/lib/workspace-change";
import { useIsMobile } from "@/hooks/use-mobile";
import { SourceActivityContext } from "@/features/tickets/source-activity";

export function App() {
  return (
    <WorkspaceChangeProvider value={useWorkspaceChangePoll()}>
      <AppContent />
    </WorkspaceChangeProvider>
  );
}

function AppContent() {
  const [view, setViewState] = useState<
    | "tickets"
    | "projects"
    | "plans"
    | "archived-plans"
    | "settings"
    | "inbox"
    | "documents"
  >("tickets");
  const [settingsSection, setSettingsSection] =
    useState<SettingsCardKey>("appearance");
  useThemeSync();
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
    }
  }, [view]);
  const [documentListRequest, setDocumentListRequest] = useState(0);
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
  const [inboxTarget, setInboxTarget] = useState<{
    reference: string;
    id: string;
    key: number;
  } | null>(null);
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
  useOnWorkspaceChange(() => loadCounts.current());
  const [graphOrigin, setGraphOrigin] = useState<string | null>(null);
  const [localGraphOrigin, setLocalGraphOrigin] = useState<string | null>(null);
  const [workspaceGraphOpen, setWorkspaceGraphOpen] = useState(false);
  // Once opened it stays mounted (hidden), so coming back restores its filters,
  // selection and viewport exactly as Back does.
  const [workspaceGraphMounted, setWorkspaceGraphMounted] = useState(false);
  // The only way to change the top-level view or the open graph: switching view
  // closes any graph, and opening a graph leaves the view as it was.
  // `keepGraph` only hides the graph so Back to context graph can return to it.
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
  useReminderNotifications((reference) => {
    setInboxTarget(null);
    setSelected(reference);
    setView("tickets");
  });
  const isMobile = useIsMobile();
  return (
    <ContextGraphNavigation.Provider value={(id) => navigate({ graph: id })}>
      <PlanNavigation.Provider
        value={(id) => {
          scope("all", "all", id);
          setView("tickets");
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
              refreshing: sourceHealth.refreshing || sourceRefresh.running,
              sources: sourceHealth.sources,
              entries: sourceEntries,
              intervalSecs: sourceHealth.interval_secs ?? null,
              openSettings: () => {
                openView("settings");
                setSettingsSection("source-github");
              },
              refreshAll: () => refreshSources(),
            }}
          >
            <SidebarProvider>
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
              <div
                className={
                  view === "settings" ? "workspace settings-open" : "workspace"
                }
              >
                {view === "settings" ? (
                  <SettingsNav
                    selected={settingsSection}
                    onSelect={setSettingsSection}
                    onBack={() => {
                      returnToSettingsEntry.current = true;
                      setView(viewBeforeSettings);
                    }}
                  />
                ) : (
                  <WorkspaceSidebar
                    onCapture={openCapture}
                    counts={counts}
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
                    setCreating={(value) => {
                      if (value) setCreateStatus(undefined);
                      setCreating(value);
                    }}
                    createTriggerRef={createTriggerRef}
                  />
                )}
                <main id="main-content" tabIndex={-1} className="content-panel">
                  {isMobile && view !== "settings" && (
                    <div className="mobile-nav-bar">
                      <SidebarTrigger
                        className="mobile-nav-trigger"
                        variant="ghost"
                        size="sm"
                        aria-label="Open navigation"
                      >
                        <Menu /> Navigation
                      </SidebarTrigger>
                    </div>
                  )}
                  {(workspaceGraphOpen || localGraphOrigin) &&
                    graphOrigin === null && (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          setGraphOrigin(localGraphOrigin ?? "__workspace__")
                        }
                      >
                        {localGraphOrigin
                          ? "Back to context graph"
                          : "Back to workspace graph"}
                      </Button>
                    )}
                  {error && (
                    <p role="alert" className="global-error">
                      {error}
                    </p>
                  )}
                  <CreateTicketDialog
                    open={creating}
                    onOpenChange={setCreating}
                    triggerRef={createTriggerRef}
                    navigation={navigation}
                    {...(createStatus && { initialStatus: createStatus })}
                    projects={projects}
                    plans={plans}
                    create={create}
                  />
                  {view === "settings" && graphOrigin === null && (
                    <SettingsView
                      selected={settingsSection}
                      onOpenInbox={() => setView("inbox")}
                      onRestore={async () => {
                        setSelected(null);
                        setDetails({});
                        bulk.reset();
                        await refresh();
                      }}
                    />
                  )}
                  {
                    <div
                      className="management"
                      hidden={view !== "projects" || graphOrigin !== null}
                    >
                      <Projects
                        projects={projects}
                        loading={loading}
                        onChange={refresh}
                      />
                    </div>
                  }
                  {(view === "plans" || view === "archived-plans") &&
                    graphOrigin === null && (
                      <PlanList
                        plans={plans}
                        archived={view === "archived-plans"}
                        onOpen={(id) => scope("all", "all", id)}
                        refresh={refresh}
                      />
                    )}
                  {view === "inbox" && graphOrigin === null && (
                    <Inbox
                      revision={revision}
                      select={(reference, noteId) => {
                        setInboxTarget(
                          noteId
                            ? { reference, id: noteId, key: Date.now() }
                            : null,
                        );
                        setSelected(reference);
                        setView("tickets");
                      }}
                    />
                  )}
                  <div
                    className="context-view-wrapper"
                    hidden={view !== "documents" || graphOrigin !== null}
                  >
                    <Documents
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
                        view === "tickets" ? workspace.selected : null
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
                        active={graphOrigin === "__workspace__"}
                        revision={revision}
                        onBack={() => {
                          setGraphOrigin(null);
                          setWorkspaceGraphOpen(false);
                        }}
                        onFocus={(id) => {
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
                        key={localGraphOrigin}
                        active={graphOrigin === localGraphOrigin}
                        origin={localGraphOrigin}
                        {...(workspaceGraphOpen && {
                          originLabel: "workspace graph",
                        })}
                        onBack={(origin) => {
                          setLocalGraphOrigin(null);
                          if (workspaceGraphOpen)
                            setGraphOrigin("__workspace__");
                          else if (origin) openGraphItem(origin);
                          else setGraphOrigin(null);
                        }}
                        onOpen={openGraphItem}
                      />
                    </div>
                  )}
                  <TicketWorkspaceView
                    workspace={workspace}
                    bulk={bulk}
                    hidden={view !== "tickets" || graphOrigin !== null}
                    inboxTarget={inboxTarget}
                    onCreate={(trigger, status) => {
                      createTriggerRef.current = trigger;
                      setCreateStatus(status);
                      setCreating(true);
                    }}
                  />
                </main>
              </div>
            </SidebarProvider>
          </SourceActivityContext.Provider>
        </DocumentNavigation.Provider>
      </PlanNavigation.Provider>
    </ContextGraphNavigation.Provider>
  );
}

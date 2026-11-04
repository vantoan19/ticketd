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
import { useIsMobile } from "@/hooks/use-mobile";
import { SourceActivityContext } from "@/features/tickets/source-activity";

export function App() {
  const [view, setView] = useState<
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
  const openView = (next: typeof view) => {
    if (next === "settings" && view !== "settings") {
      setViewBeforeSettings(view);
      setSettingsSection("appearance");
    }
    setGraphOrigin(null);
    setLocalGraphOrigin(null);
    setWorkspaceGraphOpen(false);
    setView(next);
  };
  const [inboxTarget, setInboxTarget] = useState<{
    reference: string;
    id: string;
    key: number;
  } | null>(null);
  const [counts, setCounts] = useState<SidebarCounts>({
    unread_inbox: 0,
    ready: 0,
    in_progress: 0,
  });
  useEffect(() => {
    let active = true;
    const poll = () =>
      void countsClient
        .sidebar()
        .then((value) => {
          if (active) setCounts(value);
        })
        .catch(() => {});
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const [graphOrigin, setGraphOrigin] = useState<string | null>(null);
  const [localGraphOrigin, setLocalGraphOrigin] = useState<string | null>(null);
  const [workspaceGraphOpen, setWorkspaceGraphOpen] = useState(false);
  const [capture, setCapture] = useState(false);
  const [documentTarget, setDocumentTarget] = useState<{
    id: string;
    key: number;
  } | null>(null);
  const [documentReturn, setDocumentReturn] = useState<typeof view | null>(
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
    <ContextGraphNavigation.Provider
      value={(id) => {
        setWorkspaceGraphOpen(id === "__workspace__");
        setLocalGraphOrigin(id === "__workspace__" ? null : id);
        setGraphOrigin(id);
      }}
    >
      <PlanNavigation.Provider
        value={(id) => {
          scope("all", "all", id);
          setView("tickets");
        }}
      >
        <DocumentNavigation.Provider
          value={(id) => {
            if (view !== "documents") setDocumentReturn(view);
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
                    onCapture={() => setCapture(true)}
                    counts={counts}
                    view={view}
                    setView={openView}
                    projects={projects}
                    plans={plans}
                    scope={(...args) => {
                      // A sidebar view always shows its list, not an open graph.
                      setGraphOrigin(null);
                      setLocalGraphOrigin(null);
                      setWorkspaceGraphOpen(false);
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
                        Back to context graph
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
                  {view === "settings" && (
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
                    <div className="management" hidden={view !== "projects"}>
                      <Projects
                        projects={projects}
                        loading={loading}
                        onChange={refresh}
                      />
                    </div>
                  }
                  {(view === "plans" || view === "archived-plans") && (
                    <PlanList
                      plans={plans}
                      archived={view === "archived-plans"}
                      onOpen={(id) => scope("all", "all", id)}
                      refresh={refresh}
                    />
                  )}
                  {view === "inbox" && (
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
                      target={documentTarget}
                      capture={capture}
                      currentTicket={
                        view === "tickets" ? workspace.selected : null
                      }
                      onOpenPlan={(id) => {
                        scope("all", "all", id);
                        setView("tickets");
                      }}
                      onOpenTicket={(reference) => {
                        setSelected(reference);
                        setView("tickets");
                      }}
                      onDocumentClose={() => {
                        if (documentReturn) {
                          setView(documentReturn);
                          setDocumentReturn(null);
                        }
                      }}
                      onCaptureClose={() => setCapture(false)}
                    />
                  </div>
                  {workspaceGraphOpen && (
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
                        onBack={() => {
                          setLocalGraphOrigin(null);
                          setGraphOrigin(
                            workspaceGraphOpen ? "__workspace__" : null,
                          );
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

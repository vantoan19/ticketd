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
import { Menu } from "lucide-react";
import { EffortList } from "@/features/efforts/EffortList";
import { Projects } from "@/features/projects/Projects";
import { useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { SourceActivityContext } from "@/features/tickets/source-activity";

export function App() {
  const [view, setView] = useState<
    | "tickets"
    | "projects"
    | "efforts"
    | "archived-efforts"
    | "settings"
    | "inbox"
  >("tickets");
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
    if (next === "settings" && view !== "settings") setViewBeforeSettings(view);
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
  const [creating, setCreating] = useState(false);
  // The status a group's Add action asked for; the sidebar's New ticket has none.
  const [createStatus, setCreateStatus] = useState<string | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspace = useTicketWorkspace(setView, setCreating);
  const {
    projects,
    efforts,
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
  const bulk = useBulkEdit(refresh);
  useReminderNotifications((reference) => {
    setInboxTarget(null);
    setSelected(reference);
    setView("tickets");
  });
  const isMobile = useIsMobile();
  return (
    <SourceActivityContext.Provider
      value={{
        refreshing: sourceHealth.refreshing || sourceRefresh.running,
        sources: sourceHealth.sources,
        entries: sourceEntries,
        intervalSecs: sourceHealth.interval_secs ?? null,
        openSettings: () => openView("settings"),
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
              onBack={() => {
                returnToSettingsEntry.current = true;
                setView(viewBeforeSettings);
              }}
            />
          ) : (
            <WorkspaceSidebar
              counts={counts}
              view={view}
              setView={openView}
              projects={projects}
              efforts={efforts}
              scope={scope}
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
              efforts={efforts}
              create={create}
            />
            {view === "settings" && (
              <SettingsView
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
            {(view === "efforts" || view === "archived-efforts") && (
              <EffortList
                efforts={efforts}
                archived={view === "archived-efforts"}
                onOpen={(id) => scope("all", "all", id)}
                refresh={refresh}
              />
            )}
            {view === "inbox" && (
              <Inbox
                revision={revision}
                select={(reference, noteId) => {
                  setInboxTarget(
                    noteId ? { reference, id: noteId, key: Date.now() } : null,
                  );
                  setSelected(reference);
                  setView("tickets");
                }}
              />
            )}
            <TicketWorkspaceView
              workspace={workspace}
              bulk={bulk}
              hidden={view !== "tickets"}
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
  );
}

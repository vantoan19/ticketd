import { invoke } from "@tauri-apps/api/core";
import { Inbox } from "@/features/tickets/Inbox";
import { CreateTicketDialog } from "@/features/tickets/CreateTicketDialog";
import { useTicketWorkspace } from "@/features/tickets/useTicketWorkspace";
import { useBulkEdit } from "@/features/tickets/useBulkEdit";
import { TicketWorkspaceView } from "@/features/tickets/TicketWorkspaceView";
import { WorkspaceSidebar } from "@/components/layout/WorkspaceSidebar";
import { WorkspaceSettings } from "@/features/settings/WorkspaceSettings";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { RefreshCw } from "lucide-react";
import { Efforts } from "@/features/efforts/Efforts";
import { Projects } from "@/features/projects/Projects";
import { useEffect, useRef, useState } from "react";

export function App() {
  const [view, setView] = useState<
    "tickets" | "projects" | "efforts" | "settings" | "inbox"
  >("tickets");
  const [inboxTarget, setInboxTarget] = useState<{
    reference: string;
    id: string;
    key: number;
  } | null>(null);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    let active = true;
    const poll = () =>
      void invoke("has_unread_inbox")
        .then((value) => {
          if (active && typeof value === "boolean") setUnread(value);
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
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspace = useTicketWorkspace(setView, setCreating);
  const {
    projects,
    efforts,
    filter,
    setFilter,
    setOffset,
    effort,
    status,
    availability,
    trash,
    setSelected,
    setDetails,
    error,
    loading,
    revision,
    refresh,
    create,
    scopeName,
    scope,
    navigation,
  } = workspace;
  const bulk = useBulkEdit(refresh);
  return (
    <SidebarProvider>
      <main className="workspace">
        <WorkspaceSidebar
          unread={unread}
          view={view}
          setView={setView}
          filter={filter}
          effort={effort}
          status={status}
          availability={availability}
          trash={trash}
          projects={projects}
          efforts={efforts}
          scope={scope}
          navigation={navigation}
          setCreating={setCreating}
          createTriggerRef={createTriggerRef}
        />
        <div className="main-area">
          <header className="topbar">
            <SidebarTrigger className="mobile-sidebar-trigger" />
            <div>
              <span>Workspace</span>
              <span className="slash">/</span>
              <strong>
                {view === "tickets"
                  ? scopeName
                  : view === "inbox"
                    ? "Attention inbox"
                    : view === "projects"
                      ? "Projects"
                      : view === "efforts"
                        ? "Efforts"
                        : "Settings"}
              </strong>
            </div>
            <span aria-live="polite">
              {unread && (
                <button
                  className="unread-attention"
                  onClick={() => setView("inbox")}
                >
                  Unread inbox
                </button>
              )}
            </span>
            <button
              aria-label="Refresh"
              className="icon-button"
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} />
            </button>
          </header>
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
            projects={projects}
            efforts={efforts}
            create={create}
          />
          <WorkspaceSettings
            hidden={view !== "settings"}
            onRestore={async () => {
              setSelected(null);
              setDetails({});
              bulk.reset();
              await refresh();
            }}
          />
          {
            <div className="management" hidden={view !== "projects"}>
              <h1>Projects</h1>
              <p>Manage projects and registered checkouts.</p>{" "}
              <Projects
                projects={projects}
                loading={loading}
                filter={filter}
                onFilter={(value) => {
                  setFilter(value);
                  setOffset(0);
                }}
                onChange={refresh}
              />
            </div>
          }
          {
            <div className="management" hidden={view !== "efforts"}>
              <h1>Efforts</h1>
              <p>Organize tickets into shared efforts.</p>
              <Efforts revision={revision} refresh={refresh} />
            </div>
          }
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
            onCreate={(trigger) => {
              createTriggerRef.current = trigger;
              setCreating(true);
            }}
          />
        </div>
      </main>
    </SidebarProvider>
  );
}

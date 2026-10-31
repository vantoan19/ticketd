import { CreateTicketDialog } from "@/features/tickets/CreateTicketDialog";
import { useTicketWorkspace } from "@/features/tickets/useTicketWorkspace";
import { Button } from "@/components/ui/button";
import { TicketFilters } from "@/features/tickets/TicketFilters";
import { TicketList } from "@/features/tickets/TicketList";
import { TicketDetails } from "@/features/tickets/TicketDetails";
import { WorkspaceSidebar } from "@/components/layout/WorkspaceSidebar";
import { WorkspaceSettings } from "@/features/settings/WorkspaceSettings";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Plus, RefreshCw } from "lucide-react";
import { Efforts } from "@/features/efforts/Efforts";
import { Projects } from "@/features/projects/Projects";
import { useLayoutEffect, useRef, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "cn";

export function App() {
  const [view, setView] = useState<
    "tickets" | "projects" | "efforts" | "settings"
  >("tickets");
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [narrowDetail, setNarrowDetail] = useState(false);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "ticketd.workspace",
  });
  const listRef = useRef<HTMLElement>(null);
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
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const {
    projects,
    efforts,
    filter,
    setFilter,
    query,
    setQuery,
    offset,
    setOffset,
    effort,
    setEffort,
    status,
    setStatus,
    tags,
    setTags,
    availability,
    setAvailability,
    family,
    setFamily,
    trash,
    tickets,
    selected,
    setSelected,
    details,
    setDetails,
    error,
    loading,
    revision,
    refresh,
    create,
    updateTicket,
    scopeName,
    scope,
    navigation,
    clearFilters,
    queryError,
  } = useTicketWorkspace(setView, setCreating);
  const [previousSelection, setPreviousSelection] = useState(selected);
  if (previousSelection !== selected) {
    setPreviousSelection(selected);
    setNarrowDetail(selected !== null);
    if (!selected) setExpanded(false);
  }
  return (
    <SidebarProvider>
      <main className="workspace">
        <WorkspaceSidebar
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
            <div>
              <span>Workspace</span>
              <span className="slash">/</span>
              <strong>
                {view === "tickets"
                  ? scopeName
                  : view === "projects"
                    ? "Projects"
                    : view === "efforts"
                      ? "Efforts"
                      : "Settings"}
              </strong>
            </div>
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
          <ResizablePanelGroup
            orientation="horizontal"
            className={cn(
              "ticket-workspace",
              expanded && "expanded",
              narrowDetail && "narrow-detail",
            )}
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
            hidden={view !== "tickets"}
          >
            <ResizablePanel
              id="list"
              minSize={330}
              defaultSize={480}
              className="list-panel"
            >
              <section
                className="ticket-list"
                ref={listRef}
                aria-labelledby="tickets-heading"
              >
                {!trash && (
                  <TicketFilters
                    {...{
                      query,
                      setQuery,
                      effort,
                      setEffort,
                      status,
                      setStatus,
                      tags,
                      setTags,
                      availability,
                      setAvailability,
                      family,
                      setFamily,
                      efforts,
                      setOffset,
                      navigation,
                      clearFilters,
                    }}
                  />
                )}
                <h2 id="tickets-heading" className="list-heading" tabIndex={-1}>
                  {trash ? "Deleted tickets" : "Tickets"}{" "}
                  <span>{tickets.length}</span>
                </h2>
                {queryError ? (
                  <div className="empty-state" role="alert">
                    <strong>Could not load tickets</strong>
                    <p>Try refreshing the current view.</p>
                    <Button variant="outline" onClick={() => void refresh()}>
                      Retry
                    </Button>
                  </div>
                ) : loading && tickets.length === 0 ? (
                  <p role="status" className="mt-3">
                    Loading tickets…
                  </p>
                ) : tickets.length === 0 ? (
                  <div className="empty-state">
                    {trash ? (
                      <p>No tickets in trash.</p>
                    ) : query ||
                      tags ||
                      family ||
                      effort !== navigation.effort ||
                      status !==
                        (navigation.kind === "progress" ? "In progress" : "") ||
                      availability !==
                        (navigation.kind === "ready" ? "Ready" : "") ? (
                      <>
                        <strong>No matching tickets</strong>
                        <p>Try clearing your search and filters.</p>
                        <Button variant="outline" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      </>
                    ) : navigation.project !== "all" ||
                      navigation.effort ||
                      navigation.kind !== "all" ? (
                      <>
                        <strong>No tickets in this scope</strong>
                        <p>Create a ticket or choose another view.</p>
                        <Button
                          variant="outline"
                          onClick={(event) => {
                            createTriggerRef.current = event.currentTarget;
                            setCreating(true);
                          }}
                        >
                          Create ticket
                        </Button>
                      </>
                    ) : (
                      <>
                        <strong>Your workspace is ready</strong>
                        <p>
                          Create your first ticket to start keeping track of
                          work.
                        </p>
                        <button
                          onClick={(event) => {
                            createTriggerRef.current = event.currentTarget;
                            setCreating(true);
                          }}
                        >
                          <Plus size={15} /> Create your first ticket
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <TicketList
                    tickets={tickets.filter(
                      (item) =>
                        filter === "all" ||
                        (filter === "unlinked"
                          ? item.project_id === null
                          : item.project_id === filter),
                    )}
                    selected={selected}
                    onOpen={(reference) => {
                      setSelected(reference);
                      setNarrowDetail(true);
                      if (window.matchMedia("(max-width: 950px)").matches)
                        focusPane.current = "detail";
                    }}
                  />
                )}
                {!trash && (offset > 0 || tickets.length === 50) && (
                  <div className="pagination">
                    <button
                      type="button"
                      disabled={offset === 0}
                      onClick={() => {
                        setOffset(Math.max(0, offset - 50));
                      }}
                    >
                      Previous
                    </button>
                    <span> Page {Math.floor(offset / 50) + 1} </span>
                    <button
                      type="button"
                      disabled={tickets.length < 50}
                      onClick={() => {
                        setOffset(offset + 50);
                      }}
                    >
                      Next
                    </button>
                  </div>
                )}
              </section>
            </ResizablePanel>
            <ResizableHandle
              className="split-handle"
              aria-label="Resize ticket list"
            />
            <ResizablePanel id="detail" minSize={360} className="detail-panel">
              {selected &&
                !loading &&
                !queryError &&
                !tickets.some((ticket) => ticket.reference === selected) && (
                  <p className="selection-context" role="status">
                    This ticket is outside the current results.
                  </p>
                )}
              <TicketDetails
                expanded={expanded}
                onExpand={() => {
                  setExpanded(true);
                  focusPane.current = "detail";
                }}
                onReturn={() => {
                  setExpanded(false);
                  setNarrowDetail(false);
                  focusPane.current = "list";
                }}
                selected={selected}
                setSelected={(value) => {
                  if (value === null) focusPane.current = "list";
                  setSelected(value);
                }}
                details={details}
                projects={projects}
                efforts={efforts}
                revision={revision}
                refresh={refresh}
                updateTicket={updateTicket}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </main>
    </SidebarProvider>
  );
}

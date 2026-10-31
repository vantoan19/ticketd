import { useTicketWorkspace } from "@/features/tickets/useTicketWorkspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TicketDetails } from "@/features/tickets/TicketDetails";
import { WorkspaceSidebar } from "@/components/layout/WorkspaceSidebar";
import { WorkspaceSettings } from "@/features/settings/WorkspaceSettings";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  CircleDot,
  Plus,
  Search,
  SlidersHorizontal,
  RefreshCw,
  X,
} from "lucide-react";
import { Efforts } from "@/features/efforts/Efforts";
import { Projects } from "@/features/projects/Projects";
import { useRef, useState } from "react";

export function App() {
  const [view, setView] = useState<
    "tickets" | "projects" | "efforts" | "settings"
  >("tickets");
  const [creating, setCreating] = useState(false);
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
    setTrash,
    tickets,
    selected,
    setSelected,
    details,
    setDetails,
    title,
    setTitle,
    error,
    setError,
    saving,
    loading,
    revision,
    refresh,
    create,
    updateTicket,
    scopeName,
    scope,
  } = useTicketWorkspace(setView, setCreating);
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
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogContent
              className="create-panel"
              showCloseButton={false}
              aria-describedby={undefined}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                createTriggerRef.current?.focus();
              }}
            >
              <div className="panel-heading">
                <DialogTitle>New ticket</DialogTitle>
                <button
                  aria-label="Close new ticket"
                  className="icon-button"
                  onClick={() => setCreating(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <form
                onSubmit={(event) => void create(event)}
                className="create-form"
              >
                <label className="flex flex-col gap-1">
                  New ticket title
                  <Input
                    className="rounded border border-neutral-400 bg-white p-2"
                    autoFocus
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    required
                  />
                </label>
                {error && <p role="alert">{error}</p>}
                <Button
                  className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
                  disabled={saving}
                >
                  Create ticket
                </Button>
              </form>
            </DialogContent>
          </Dialog>
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
          <div className="ticket-workspace" hidden={view !== "tickets"}>
            <section className="ticket-list" aria-labelledby="tickets-heading">
              <div className="list-header">
                <div>
                  <h1>{scopeName}</h1>
                  <p>Your workspace tickets, in one place.</p>
                </div>
              </div>
              {!trash && (
                <div className="list-controls">
                  <label className="search">
                    <Search size={16} />
                    <span className="sr-only">Search tickets</span>
                    <Input
                      aria-label="Search tickets"
                      placeholder="Search tickets..."
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setOffset(0);
                      }}
                    />
                  </label>{" "}
                  {!trash && (
                    <Popover>
                      <PopoverTrigger className="filters-trigger">
                        <SlidersHorizontal size={14} /> Filters
                        {tags || family || status || availability || effort
                          ? " • Active"
                          : ""}
                      </PopoverTrigger>
                      <PopoverContent className="filters-content" align="end">
                        <fieldset>
                          <legend>Filters</legend>
                          <label>
                            Effort
                            <select
                              value={effort}
                              onChange={(e) => {
                                setEffort(e.target.value);
                                setOffset(0);
                              }}
                            >
                              <option value="">All Efforts</option>
                              {efforts.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                  {item.archived ? " (archived)" : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Status{" "}
                            <select
                              value={status}
                              onChange={(e) => {
                                setStatus(e.target.value);
                                setOffset(0);
                              }}
                            >
                              <option value="">All statuses</option>
                              {[
                                "Todo",
                                "In progress",
                                "In review",
                                "Done",
                                "Canceled",
                              ].map((value) => (
                                <option key={value}>{value}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Tags (comma separated; all tags required){" "}
                            <input
                              value={tags}
                              onChange={(e) => {
                                setTags(e.target.value);
                                setOffset(0);
                              }}
                              className="rounded border p-1"
                            />
                          </label>
                          <label>
                            Availability{" "}
                            <select
                              value={availability}
                              onChange={(e) => {
                                setAvailability(e.target.value);
                                setOffset(0);
                              }}
                            >
                              <option value="">All availability</option>
                              <option>Ready</option>
                              <option>Blocked</option>
                            </select>
                          </label>
                          <label>
                            Parent family reference{" "}
                            <input
                              value={family}
                              onChange={(e) => {
                                setFamily(e.target.value);
                                setOffset(0);
                              }}
                              className="rounded border p-1"
                            />
                          </label>
                        </fieldset>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              )}
              <h2 id="tickets-heading" className="list-heading">
                {trash ? "Deleted tickets" : "Tickets"}{" "}
                <span>{tickets.length}</span>
              </h2>
              {loading ? (
                <p role="status" className="mt-3">
                  Loading tickets…
                </p>
              ) : tickets.length === 0 ? (
                <div className="empty-state">
                  {!trash &&
                  !query &&
                  filter === "all" &&
                  !effort &&
                  !status &&
                  !tags &&
                  !availability &&
                  !family ? (
                    <>
                      <strong>Your workspace is ready</strong>
                      <p>
                        Create your first ticket to start keeping track of work.
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
                  ) : (
                    <p>
                      {trash
                        ? "No tickets in trash."
                        : "No tickets match the active filters."}
                    </p>
                  )}
                </div>
              ) : (
                <ul className="mt-3 divide-y divide-neutral-200">
                  {tickets
                    .filter(
                      (item) =>
                        filter === "all" ||
                        (filter === "unlinked"
                          ? item.project_id === null
                          : item.project_id === filter),
                    )
                    .map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(item.reference)}
                          aria-pressed={item.reference === selected}
                          className="w-full rounded p-3 text-left hover:bg-neutral-100 aria-pressed:bg-neutral-200"
                        >
                          <CircleDot size={16} className="row-status" />
                          <span className="ticket-ref">{item.reference}</span>
                          <span className="ticket-title">
                            {item.title}
                          </span>{" "}
                          {item.parent && (
                            <span>
                              {" "}
                              · Parent: {item.parent.reference}
                              {item.parent.trashed ? " (trashed)" : ""}
                            </span>
                          )}
                          {item.availability && (
                            <span> · {item.availability}</span>
                          )}
                          {item.tags.length > 0 && (
                            <span className="ml-2 text-sm text-neutral-600">
                              {item.tags.join(", ")}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                </ul>
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
            <TicketDetails
              selected={selected}
              setSelected={setSelected}
              details={details}
              projects={projects}
              revision={revision}
              refresh={refresh}
              updateTicket={updateTicket}
              setError={setError}
              setTrash={setTrash}
            />
          </div>
        </div>
      </main>
    </SidebarProvider>
  );
}

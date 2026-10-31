import {
  Inbox,
  CircleDot,
  CheckCircle2,
  Trash2,
  Settings,
  Plus,
  Search,
  SlidersHorizontal,
  Folder,
  Layers,
  RefreshCw,
  X,
} from "lucide-react";
import { Hierarchy } from "./Hierarchy";
import { Efforts } from "./Efforts";
import { Projects, TicketProject } from "./Projects";
import { Dependencies } from "./Dependencies";
import { Notes } from "./Notes";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { History } from "./History";
import { client, type Project, type Ticket } from "./client";
import { Tags } from "./Tags";
import { TicketEditor } from "./TicketEditor";

const DependencyGraph = lazy(() => import("./DependencyGraph"));

export function App() {
  const [view, setView] = useState<
    "tickets" | "projects" | "efforts" | "settings"
  >("tickets");
  const [creating, setCreating] = useState(false);
  const [backupPath, setBackupPath] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [exportPath, setExportPath] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [efforts, setEfforts] = useState<
    { id: string; name: string; archived: boolean }[]
  >([]);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [effort, setEffort] = useState("");
  const [status, setStatus] = useState("");
  const [tags, setTags] = useState("");
  const [availability, setAvailability] = useState("");
  const [family, setFamily] = useState("");
  const [trash, setTrash] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Ticket>>({});
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    let timeout = 0;
    try {
      const result = await Promise.race([
        Promise.all([
          trash
            ? client.listTrash()
            : client.findTickets({
                query,
                project:
                  filter === "all" || filter === "unlinked" ? null : filter,
                unlinked: filter === "unlinked",
                effort: effort || null,
                status: status || null,
                tags: tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                availability: availability || null,
                family: family || null,
                limit: 50,
                offset,
              }),
          client.listProjects(),
          client.listEfforts(),
        ]),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error("Timed out")),
            5000,
          );
        }),
      ]);
      if (request !== generation.current) return;
      setTickets(result[0]);
      setProjects(result[1]);
      setEfforts(result[2]);
      setRevision((value) => value + 1);
      setError("");
    } catch (reason) {
      if (request !== generation.current) return;
      setError(
        `Refresh failed: ${String(reason)}. Displayed information may be stale.`,
      );
    } finally {
      window.clearTimeout(timeout);
      if (request === generation.current) setLoading(false);
    }
  }, [
    trash,
    query,
    filter,
    offset,
    effort,
    status,
    tags,
    availability,
    family,
  ]);
  useEffect(() => {
    const generationRef = generation;
    const timer = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      generationRef.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const request = ++detailGeneration.current;
    void client.showTicket(selected).then(
      (ticket) => {
        if (active && request === detailGeneration.current)
          setDetails((previous) => ({
            ...previous,
            [ticket.reference]: ticket,
          }));
      },
      (reason: unknown) => {
        if (active) setError(`Ticket refresh failed: ${String(reason)}`);
      },
    );
    return () => {
      active = false;
    };
  }, [selected, revision]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const ticket = await client.createTicket(
        title,
        filter === "all" || filter === "unlinked" ? null : filter,
      );
      setTitle("");
      setCreating(false);
      await refresh();
      setSelected(ticket.reference);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }
  const updateTicket = useCallback((updated: Ticket) => {
    generation.current++;
    detailGeneration.current++;
    setDetails((items) => ({ ...items, [updated.reference]: updated }));
    setTickets((items) =>
      items.map((item) => (item.id === updated.id ? updated : item)),
    );
  }, []);
  const scopeName = trash
    ? "Trash"
    : filter === "unlinked"
      ? "Unlinked"
      : (projects.find((p) => p.id === filter)?.name ??
        (effort
          ? efforts.find((e) => e.id === effort)?.name
          : status || availability || "All tickets"));
  function scope(
    next: "all" | "ready" | "progress" | "trash",
    project = "all",
    effortId = "",
  ) {
    setView("tickets");
    setTrash(next === "trash");
    setFilter(project);
    setEffort(effortId);
    setStatus(next === "progress" ? "In progress" : "");
    setAvailability(next === "ready" ? "Ready" : "");
    setOffset(0);
    setSelected(null);
  }
  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <strong>ticketd</strong>
          <span className="brand-label">WORKSPACE</span>
        </div>
        <button
          className="new-ticket"
          onClick={() => {
            setView("tickets");
            setCreating(true);
          }}
        >
          <Plus size={16} /> New ticket
        </button>
        <nav aria-label="Workspace views" className="sidebar-nav">
          <button
            className={
              !trash &&
              filter === "all" &&
              !effort &&
              !status &&
              !availability &&
              view === "tickets"
                ? "active"
                : ""
            }
            onClick={() => scope("all")}
          >
            <Inbox size={16} /> All tickets
          </button>
          <button
            className={
              availability === "Ready" && view === "tickets" ? "active" : ""
            }
            onClick={() => scope("ready")}
          >
            <CheckCircle2 size={16} /> Ready
          </button>
          <button
            className={
              status === "In progress" && view === "tickets" ? "active" : ""
            }
            onClick={() => scope("progress")}
          >
            <CircleDot size={16} /> In progress
          </button>
          <button
            className={trash && view === "tickets" ? "active" : ""}
            onClick={() => scope("trash")}
          >
            <Trash2 size={16} /> Trash
          </button>
        </nav>
        <div className="sidebar-scroll">
          <div className="sidebar-heading">
            Projects{" "}
            <button
              aria-label="Manage projects"
              onClick={() => setView("projects")}
            >
              <Plus size={15} />
            </button>
          </div>
          <nav aria-label="Project scopes" className="sidebar-nav">
            <button
              className={
                filter === "unlinked" && view === "tickets" ? "active" : ""
              }
              onClick={() => scope("all", "unlinked")}
            >
              <Folder size={15} /> Unlinked
            </button>
            {projects.map((p) => (
              <button
                key={p.id}
                aria-pressed={filter === p.id && view === "tickets"}
                className={
                  filter === p.id && view === "tickets" ? "active" : ""
                }
                onClick={() => scope("all", p.id)}
              >
                <Folder size={15} /> {p.name}
              </button>
            ))}
          </nav>
          <div className="sidebar-heading">
            Efforts{" "}
            <button
              aria-label="Manage Efforts"
              onClick={() => setView("efforts")}
            >
              <Plus size={15} />
            </button>
          </div>
          <nav aria-label="Effort scopes" className="sidebar-nav">
            {efforts.map((e) => (
              <button
                key={e.id}
                className={
                  effort === e.id && view === "tickets" ? "active" : ""
                }
                onClick={() => scope("all", "all", e.id)}
              >
                <Layers size={15} /> {e.name}
                {e.archived ? " (archived)" : ""}
              </button>
            ))}
          </nav>
        </div>
        <button className="settings-link" onClick={() => setView("settings")}>
          <Settings size={16} /> Workspace settings
        </button>
      </aside>
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
        {creating && (
          <div className="create-panel">
            <div className="panel-heading">
              <strong>New ticket</strong>
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
                <input
                  className="rounded border border-neutral-400 bg-white p-2"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                />
              </label>
              <button
                className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
                disabled={saving}
              >
                Create ticket
              </button>
            </form>
          </div>
        )}
        {view === "settings" && (
          <div className="management">
            <h1>Workspace settings</h1>
            <p>Manage your workspace data.</p>
            <div className="settings-card">
              <h2>Backup & restore</h2>{" "}
              <section aria-label="Workspace backup">
                <label>
                  Backup file path{" "}
                  <input
                    value={backupPath}
                    onChange={(event) => setBackupPath(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={!backupPath || backupBusy}
                  onClick={() =>
                    void (async () => {
                      setBackupBusy(true);
                      try {
                        setBackupMessage(
                          await client.backupWorkspace(backupPath),
                        );
                      } catch (reason) {
                        setBackupMessage(`Backup failed: ${String(reason)}`);
                      } finally {
                        setBackupBusy(false);
                      }
                    })()
                  }
                >
                  Back up
                </button>
                <button
                  type="button"
                  disabled={!backupPath || backupBusy}
                  onClick={() =>
                    void (async () => {
                      if (
                        !window.confirm(
                          "Restore this backup? Current workspace data will be replaced after a safety backup is made.",
                        )
                      )
                        return;
                      setBackupBusy(true);
                      try {
                        setBackupMessage(
                          await client.restoreWorkspace(backupPath),
                        );
                        setSelected(null);
                        setDetails({});
                        await refresh();
                      } catch (reason) {
                        setBackupMessage(`Restore failed: ${String(reason)}`);
                      } finally {
                        setBackupBusy(false);
                      }
                    })()
                  }
                >
                  Restore backup
                </button>
                <p role="status">{backupMessage}</p>
              </section>
            </div>
            <div className="settings-card">
              <h2>Export</h2>{" "}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setExportMessage("");
                  void client
                    .exportWorkspace(exportPath)
                    .then(() => setExportMessage("Export saved."))
                    .catch((reason: unknown) =>
                      setExportMessage(`Export failed: ${String(reason)}`),
                    );
                }}
              >
                <label>
                  Export file path{" "}
                  <input
                    className="rounded border border-neutral-400 bg-white p-2"
                    value={exportPath}
                    onChange={(event) => setExportPath(event.target.value)}
                    required
                  />
                </label>{" "}
                <button type="submit">Export workspace</button>
                {exportMessage && <p role="status">{exportMessage}</p>}
              </form>
            </div>
          </div>
        )}
        {view === "projects" && (
          <div className="management">
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
        )}
        {view === "efforts" && (
          <div className="management">
            <h1>Efforts</h1>
            <p>Organize tickets into shared efforts.</p>
            <Efforts revision={revision} refresh={refresh} />
          </div>
        )}
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
                  <input
                    placeholder="Search tickets..."
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setOffset(0);
                    }}
                  />
                </label>{" "}
                {!trash && (
                  <details className="filters">
                    <summary>
                      <SlidersHorizontal size={14} /> Filters
                    </summary>
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
                  </details>
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
                    <button onClick={() => setCreating(true)}>
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
                        <span className="ticket-title">{item.title}</span>{" "}
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
          <section className="ticket-detail" aria-labelledby="detail-heading">
            <div className="detail-header">
              <h2 id="detail-heading">Ticket details</h2>
              {selected && (
                <button
                  className="icon-button"
                  aria-label="Close ticket details"
                  onClick={() => setSelected(null)}
                >
                  <X size={16} />
                </button>
              )}
            </div>
            {selected === null && (
              <p className="mt-3">Select a ticket to see its details.</p>
            )}
            {Object.values(details).map((item) => (
              <div
                className="detail-content"
                key={item.id}
                hidden={item.reference !== selected}
              >
                {item.trashed ? (
                  <div className="detail-metadata">
                    {item.reference === selected && (
                      <History
                        reference={item.reference}
                        projects={projects}
                        status={item.status}
                        trashed={item.trashed}
                        revision={revision}
                        onChange={refresh}
                      />
                    )}
                    {!item.trashed && (
                      <TicketProject
                        ticket={item}
                        projects={projects}
                        onSaved={updateTicket}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void client
                          .setTrashed(item.reference, !item.trashed)
                          .then(refresh)
                          .catch((reason: unknown) => setError(String(reason)))
                      }
                    >
                      {item.trashed ? "Restore" : "Move to trash"}
                    </button>
                  </div>
                ) : (
                  <TicketEditor ticket={item} onSaved={updateTicket}>
                    <div className="detail-metadata">
                      {item.reference === selected && (
                        <History
                          reference={item.reference}
                          projects={projects}
                          status={item.status}
                          trashed={item.trashed}
                          revision={revision}
                          onChange={refresh}
                        />
                      )}
                      {!item.trashed && (
                        <TicketProject
                          ticket={item}
                          projects={projects}
                          onSaved={updateTicket}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          void client
                            .setTrashed(item.reference, !item.trashed)
                            .then(refresh)
                            .catch((reason: unknown) =>
                              setError(String(reason)),
                            )
                        }
                      >
                        {item.trashed ? "Restore" : "Move to trash"}
                      </button>
                    </div>
                  </TicketEditor>
                )}
                {item.reference === selected && !item.trashed && (
                  <>
                    <details className="detail-disclosure">
                      <summary>Relationships & graph</summary>
                      <Hierarchy
                        ticket={item}
                        refresh={refresh}
                        select={setSelected}
                      />
                      <Dependencies ticket={item} refresh={refresh} />
                      <Suspense fallback={<p>Loading graph…</p>}>
                        <DependencyGraph
                          key={item.reference}
                          reference={item.reference}
                          revision={revision}
                          select={(reference, trashed) => {
                            setSelected(reference);
                            setTrash(trashed);
                          }}
                        />
                      </Suspense>
                    </details>
                  </>
                )}
                {!item.trashed && (
                  <details className="detail-disclosure">
                    <summary>Notes</summary>
                    <Notes
                      reference={item.reference}
                      refreshRevision={revision}
                    />
                  </details>
                )}
                {!item.trashed && (
                  <details className="detail-disclosure">
                    <summary>Tags</summary>
                    <Tags
                      reference={item.reference}
                      tags={item.tags}
                      refresh={refresh}
                    />
                  </details>
                )}
              </div>
            ))}
          </section>
        </div>
      </div>
    </main>
  );
}

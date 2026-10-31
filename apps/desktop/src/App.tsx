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
  const [backupPath, setBackupPath] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
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
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
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
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const ticket = await client.createTicket(
        title,
        filter === "all" || filter === "unlinked" ? null : filter,
      );
      setTitle("");
      await refresh();
      setSelected(ticket.id);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }
  const updateTicket = useCallback((updated: Ticket) => {
    generation.current++;
    setTickets((items) =>
      items.map((item) => (item.id === updated.id ? updated : item)),
    );
  }, []);
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-3xl font-semibold">ticketd</h1>
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
                setBackupMessage(await client.backupWorkspace(backupPath));
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
                setBackupMessage(await client.restoreWorkspace(backupPath));
                setSelected(null);
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
      <form
        onSubmit={(event) => void create(event)}
        className="my-6 flex flex-wrap items-end gap-3"
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
        <button
          type="button"
          className="rounded border border-neutral-400 px-4 py-2"
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </form>
      {error && (
        <p role="alert" className="my-3 text-red-700">
          {error}
        </p>
      )}
      <Efforts revision={revision} refresh={refresh} />
      <Projects
        projects={projects}
        filter={filter}
        onFilter={(value) => {
          setFilter(value);
          setOffset(0);
        }}
        onChange={refresh}
      />
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="tickets-heading">
          <button
            type="button"
            onClick={() => {
              setTrash(!trash);
              setSelected(null);
            }}
          >
            {trash ? "Show tickets" : "Show trash"}
          </button>
          {!trash && (
            <label className="flex flex-col gap-1">
              Search tickets
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOffset(0);
                  setSelected(null);
                }}
                className="rounded border border-neutral-400 bg-white p-2"
              />
            </label>
          )}
          {!trash && (
            <fieldset className="my-3 grid gap-2">
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
                  {["Todo", "In progress", "In review", "Done", "Canceled"].map(
                    (value) => (
                      <option key={value}>{value}</option>
                    ),
                  )}
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
          )}
          <h2 id="tickets-heading" className="text-xl font-semibold">
            {trash ? "Trash" : "Tickets"}
          </h2>
          {loading ? (
            <p role="status" className="mt-3">
              Loading tickets…
            </p>
          ) : tickets.length === 0 ? (
            <p className="mt-3">
              {!trash
                ? "No tickets match the active filters."
                : "No tickets in trash."}
            </p>
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
                      onClick={() => setSelected(item.id)}
                      aria-pressed={item.id === selected}
                      className="w-full rounded p-3 text-left hover:bg-neutral-100 aria-pressed:bg-neutral-200"
                    >
                      <span className="mr-3 text-neutral-600">
                        {item.reference}
                      </span>
                      {item.title}{" "}
                      {item.parent && (
                        <span>
                          {" "}
                          · Parent: {item.parent.reference}
                          {item.parent.trashed ? " (trashed)" : ""}
                        </span>
                      )}
                      {item.availability && <span> · {item.availability}</span>}
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
          {!trash && (
            <div>
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => {
                  setOffset(Math.max(0, offset - 50));
                  setSelected(null);
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
                  setSelected(null);
                }}
              >
                Next
              </button>
            </div>
          )}
        </section>
        <section aria-labelledby="detail-heading">
          <h2 id="detail-heading" className="text-xl font-semibold">
            Ticket details
          </h2>
          {selected === null && (
            <p className="mt-3">Select a ticket to see its details.</p>
          )}
          {tickets.map((item) => (
            <div key={item.id} hidden={item.id !== selected}>
              {item.id === selected && (
                <History
                  reference={item.reference}
                  projects={projects}
                  status={item.status}
                  trashed={item.trashed}
                  revision={revision}
                  onChange={refresh}
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
              {!item.trashed && (
                <TicketProject
                  ticket={item}
                  projects={projects}
                  onSaved={updateTicket}
                />
              )}
              {!item.trashed && (
                <TicketEditor ticket={item} onSaved={updateTicket} />
              )}
              {item.id === selected && !item.trashed && (
                <>
                  <Hierarchy
                    ticket={item}
                    refresh={refresh}
                    select={(reference) =>
                      setSelected(
                        tickets.find((ticket) => ticket.reference === reference)
                          ?.id ?? null,
                      )
                    }
                  />
                  <Dependencies ticket={item} refresh={refresh} />
                  <Suspense fallback={<p>Loading graph…</p>}>
                    <DependencyGraph
                      key={item.reference}
                      reference={item.reference}
                      revision={revision}
                      select={(id, trashed) => {
                        setSelected(id);
                        setTrash(trashed);
                      }}
                    />
                  </Suspense>
                  <Notes
                    reference={item.reference}
                    refreshRevision={revision}
                  />
                </>
              )}
              {!item.trashed && (
                <Tags
                  reference={item.reference}
                  tags={item.tags}
                  refresh={refresh}
                />
              )}
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}

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
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState("all");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const request = ++generation.current;
    let timeout = 0;
    try {
      const result = await Promise.race([
        Promise.all([client.listTickets(), client.listProjects()]),
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
      setRevision((value) => value + 1);
      setError("");
    } catch (reason) {
      if (request !== generation.current) return;
      setError(
        `Refresh failed: ${String(reason)}. Displayed information may be stale.`,
      );
    } finally {
      window.clearTimeout(timeout);
      refreshing.current = false;
      if (request === generation.current) setLoading(false);
    }
  }, []);
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
        onFilter={setFilter}
        onChange={refresh}
      />
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="tickets-heading">
          <h2 id="tickets-heading" className="text-xl font-semibold">
            Tickets
          </h2>
          {loading ? (
            <p role="status" className="mt-3">
              Loading tickets…
            </p>
          ) : tickets.length === 0 ? (
            <p className="mt-3">No tickets yet.</p>
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
                        <span> · Parent: {item.parent.reference}</span>
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
                  revision={revision}
                  onChange={refresh}
                />
              )}
              <TicketProject
                ticket={item}
                projects={projects}
                onSaved={updateTicket}
              />
              <TicketEditor ticket={item} onSaved={updateTicket} />
              {item.id === selected && (
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
                      select={(reference) =>
                        setSelected(
                          tickets.find(
                            (ticket) => ticket.reference === reference,
                          )?.id ?? null,
                        )
                      }
                    />
                  </Suspense>
                  <Notes
                    reference={item.reference}
                    refreshRevision={revision}
                  />
                </>
              )}
              <Tags
                reference={item.reference}
                tags={item.tags}
                refresh={refresh}
              />
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}

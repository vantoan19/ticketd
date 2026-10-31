import { History } from "./History";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { client, type Ticket } from "./client";
import { Tags } from "./Tags";
import { TicketEditor } from "./TicketEditor";

export function App() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setTickets(await client.listTickets());
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const ticket = await client.createTicket(title);
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
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="tickets-heading">
          <h2 id="tickets-heading" className="text-xl font-semibold">
            Tickets
          </h2>
          {tickets.length === 0 ? (
            <p className="mt-3">No tickets yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-neutral-200">
              {tickets.map((item) => (
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
                    {item.title}
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
                  status={item.status}
                  onChange={refresh}
                />
              )}
              <TicketEditor ticket={item} onSaved={updateTicket} />
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

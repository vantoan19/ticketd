import { invoke } from "@tauri-apps/api/core";
import { History } from "./History";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type Ticket = { id: string; reference: string; title: string; status: string };

function parseTicket(value: unknown): Ticket {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid ticket returned by workspace");
  const ticket = value as Record<string, unknown>;
  if (
    typeof ticket.id !== "string" ||
    typeof ticket.reference !== "string" ||
    typeof ticket.title !== "string" ||
    typeof ticket.status !== "string"
  )
    throw new Error("Invalid ticket returned by workspace");
  return {
    id: ticket.id,
    reference: ticket.reference,
    title: ticket.title,
    status: ticket.status,
  };
}

export function App() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const result: unknown = await invoke("list_tickets");
      if (!Array.isArray(result))
        throw new Error("Invalid ticket list returned by workspace");
      setTickets(result.map(parseTicket));
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
      const ticket = parseTicket(await invoke("create_ticket", { title }));
      setTitle("");
      await refresh();
      setSelected(ticket.id);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }
  const ticket = tickets.find((item) => item.id === selected);
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
          {ticket ? (
            <div className="mt-3">
              <p className="text-neutral-600">
                {ticket.reference} · {ticket.status}
              </p>
              <h3 className="mt-2 text-lg">{ticket.title}</h3>
              <History
                reference={ticket.reference}
                status={ticket.status}
                onChange={refresh}
              />
            </div>
          ) : (
            <p className="mt-3">Select a ticket to see its details.</p>
          )}
        </section>
      </div>
    </main>
  );
}

import { effortsClient, type Effort, type View } from "@/lib/api/efforts";
import { useCallback, useEffect, useState, type FormEvent } from "react";

export function Efforts({
  revision,
  refresh,
}: {
  revision: number;
  refresh: () => Promise<void>;
}) {
  const [efforts, setEfforts] = useState<Effort[]>([]);
  const [selected, setSelected] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setEfforts(await effortsClient.list());
      setView(selected ? await effortsClient.show(selected) : null);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [selected]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, revision]);
  async function action(fn: () => Promise<unknown>) {
    try {
      await fn();
      await load();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }
  function create(e: FormEvent) {
    e.preventDefault();
    void action(async () => {
      const result = await effortsClient.create(name);
      setName("");
      setSelected(result.id);
    });
  }
  return (
    <section className="my-6" aria-labelledby="efforts-heading">
      <h2 id="efforts-heading" className="text-xl font-semibold">
        Efforts
      </h2>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={create} className="my-2 flex gap-2">
        <label>
          New Effort{" "}
          <input
            className="border p-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <button className="border px-2">Create</button>
      </form>
      <label>
        View Effort{" "}
        <select
          className="border p-1"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Select</option>
          {efforts.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.archived ? " (Archived)" : ""}
            </option>
          ))}
        </select>
      </label>
      {view && (
        <div className="my-3 space-y-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action(() =>
                effortsClient.change(selected, String(form.get("name")), null),
              );
            }}
          >
            <label>
              Name{" "}
              <input
                key={view.effort.name}
                name="name"
                defaultValue={view.effort.name}
                required
                className="border p-1"
              />
            </label>{" "}
            <button className="border px-2">Rename</button>
          </form>
          <button
            className="border px-2"
            onClick={() =>
              void action(() =>
                effortsClient.change(selected, null, !view.effort.archived),
              )
            }
          >
            {view.effort.archived ? "Reactivate" : "Archive"}
          </button>
          <p>
            Todo: {view.counts.todo} · In progress: {view.counts.in_progress} ·
            In review: {view.counts.in_review} · Done: {view.counts.done} ·
            Canceled: {view.counts.canceled}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await effortsClient.setMember(reference, selected);
                setReference("");
              });
            }}
          >
            <label>
              Ticket reference{" "}
              <input
                className="border p-1"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                required
              />
            </label>{" "}
            <button className="border px-2">Add member</button>
          </form>
          <ul>
            {view.members.map((t) => (
              <li key={t.reference}>
                {t.reference} {t.title} · {t.status}{" "}
                <button
                  className="border px-2"
                  onClick={() =>
                    void action(() =>
                      effortsClient.setMember(t.reference, null),
                    )
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

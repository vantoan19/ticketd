import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

const effortSchema = z.object({
  id: z.string(),
  name: z.string(),
  archived: z.boolean(),
});
const viewSchema = z.object({
  effort: effortSchema,
  counts: z.object({
    todo: z.number(),
    in_progress: z.number(),
    in_review: z.number(),
    done: z.number(),
    canceled: z.number(),
  }),
  members: z.array(
    z.object({ reference: z.string(), title: z.string(), status: z.string() }),
  ),
});

type Effort = z.infer<typeof effortSchema>;
type View = z.infer<typeof viewSchema>;
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
      setEfforts(z.array(effortSchema).parse(await invoke("list_efforts")));
      setView(
        selected
          ? viewSchema.parse(await invoke("show_effort", { id: selected }))
          : null,
      );
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [selected]);
  useEffect(() => {
    void load();
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
      const result = effortSchema.parse(
        await invoke("create_effort", { name }),
      );
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
                invoke("change_effort", {
                  id: selected,
                  name: form.get("name"),
                  archived: null,
                }),
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
                invoke("change_effort", {
                  id: selected,
                  name: null,
                  archived: !view.effort.archived,
                }),
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
                await invoke("set_effort", { reference, effort: selected });
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
                      invoke("set_effort", {
                        reference: t.reference,
                        effort: null,
                      }),
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

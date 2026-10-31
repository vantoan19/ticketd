import { invoke } from "@tauri-apps/api/core";
import { useState, type FormEvent } from "react";
import type { Ticket } from "./client";

export function Hierarchy({
  ticket,
  refresh,
  select,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
  select: (reference: string) => void;
}) {
  const [parent, setParent] = useState("");
  const [error, setError] = useState("");
  async function change(value: string | null) {
    try {
      await invoke("set_parent", {
        reference: ticket.reference,
        parent: value,
      });
      setParent("");
      setError("");
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change(parent);
  }
  return (
    <section aria-label="Hierarchy">
      <h3>Hierarchy</h3>
      {ticket.parent && (
        <p>
          Parent:{" "}
          <button
            type="button"
            onClick={() => select(ticket.parent!.reference)}
          >
            {ticket.parent.reference} {ticket.parent.title}
            {ticket.parent.trashed && " (trashed)"}
          </button>{" "}
          <button type="button" onClick={() => void change(null)}>
            Remove parent
          </button>
        </p>
      )}
      <h4>Subtickets</h4>
      <ul>
        {ticket.children.map((child) => (
          <li key={child.reference}>
            <button type="button" onClick={() => select(child.reference)}>
              {child.reference} {child.title}
              {child.trashed && " (trashed)"}
            </button>
            {child.trashed && (
              <button
                type="button"
                onClick={() =>
                  void invoke("detach_child", {
                    child: child.reference,
                    parent: ticket.reference,
                  })
                    .then(refresh)
                    .catch((reason: unknown) => setError(String(reason)))
                }
              >
                Remove {child.reference}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <label>
          Parent reference{" "}
          <input
            value={parent}
            onChange={(event) => setParent(event.target.value)}
            required
          />
        </label>{" "}
        <button>Set parent</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

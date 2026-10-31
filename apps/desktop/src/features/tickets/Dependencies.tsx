import { client } from "@/lib/api/client";
import { useState, type FormEvent } from "react";
import type { Ticket } from "@/lib/api/client";

export function Dependencies({
  ticket,
  refresh,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
}) {
  const [blocker, setBlocker] = useState("");
  const [error, setError] = useState("");
  async function change(
    command: "add_dependency" | "remove_dependency",
    reference: string,
  ) {
    try {
      await client.changeDependency(command, reference, ticket.reference);
      setBlocker("");
      setError("");
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change("add_dependency", blocker);
  }
  return (
    <section aria-label="Prerequisites">
      <h3>Prerequisites</h3>
      <ul>
        {ticket.prerequisites.map((item) => (
          <li key={item.reference}>
            {item.reference} {item.title} ({item.status}
            {item.status !== "Done" && ", unresolved"}
            {item.trashed && ", trashed"}){" "}
            <button
              type="button"
              onClick={() => void change("remove_dependency", item.reference)}
            >
              Remove {item.reference}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add}>
        <label>
          Blocker reference{" "}
          <input
            value={blocker}
            onChange={(event) => setBlocker(event.target.value)}
            required
          />
        </label>{" "}
        <button>Add prerequisite</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

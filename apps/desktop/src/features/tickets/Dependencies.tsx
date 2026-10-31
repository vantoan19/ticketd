import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { client, type Ticket } from "@/lib/api/client";

export function Dependencies({
  ticket,
  refresh,
  select,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
  select: (reference: string, trashed: boolean) => void;
}) {
  const [blocker, setBlocker] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function change(
    command: "add_dependency" | "remove_dependency",
    reference: string,
  ) {
    setPending(true);
    setError("");
    try {
      await client.changeDependency(command, reference, ticket.reference);
      setBlocker("");
      await refresh();
    } catch (reason) {
      setError(
        `${command === "add_dependency" ? "Could not add" : "Could not remove"} ${reference}: ${String(reason)}`,
      );
    } finally {
      setPending(false);
    }
  }
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change("add_dependency", blocker.trim());
  }
  return (
    <section className="relationship-section" aria-label="Prerequisites">
      <h3>
        Prerequisites <span>{ticket.prerequisites.length}</span>
      </h3>
      {ticket.prerequisites.length === 0 ? (
        <p className="relationship-empty">
          No prerequisites. This ticket has no blockers.
        </p>
      ) : (
        <ul className="relationship-list">
          {ticket.prerequisites.map((item) => (
            <li key={item.reference}>
              <div className="relationship-ticket">
                <Button
                  variant="link"
                  className="relationship-link"
                  onClick={() => select(item.reference, item.trashed)}
                >
                  {item.reference} {item.title}
                </Button>
                <p>
                  {item.status}
                  {item.status !== "Done" && " · Unresolved"}
                  {item.trashed && " · Trashed"}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => void change("remove_dependency", item.reference)}
              >
                Remove {item.reference}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="relationship-form">
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={`blocker-${ticket.id}`}>
              Blocker reference
            </FieldLabel>
            <div className="relationship-input">
              <Input
                id={`blocker-${ticket.id}`}
                value={blocker}
                onChange={(event) => setBlocker(event.target.value)}
                required
                aria-invalid={!!error}
              />
              <Button type="submit" variant="outline" disabled={pending}>
                {pending ? "Saving…" : "Add prerequisite"}
              </Button>
            </div>
            <FieldError>{error}</FieldError>
          </Field>
        </FieldGroup>
      </form>
    </section>
  );
}

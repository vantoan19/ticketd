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

export function Duplicates({
  ticket,
  refresh,
  select,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
  select: (reference: string) => void;
}) {
  const [canonical, setCanonical] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<{ key: string; id: string } | null>(
    null,
  );
  async function save(target: string | null) {
    const key = target ?? "remove";
    const id = attempt?.key === key ? attempt.id : crypto.randomUUID();
    setAttempt({ key, id });
    setPending(true);
    setError("");
    try {
      if (target === null) await client.removeDuplicate(ticket.reference, id);
      else await client.markDuplicate(ticket.reference, target, id);
      setAttempt(null);
      setCanonical("");
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(canonical.trim());
  }
  return (
    <section className="relationship-section" aria-label="Duplicates">
      <h3>Duplicates</h3>
      {ticket.duplicate_of && (
        <p>
          Duplicate of{" "}
          <Button variant="link" onClick={() => select(ticket.duplicate_of!)}>
            {ticket.duplicate_of}
          </Button>{" "}
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void save(null)}
          >
            Remove duplicate designation
          </Button>
        </p>
      )}
      {(ticket.duplicates ?? []).map((reference) => (
        <p key={reference}>
          Duplicate:{" "}
          <Button variant="link" onClick={() => select(reference)}>
            {reference}
          </Button>
        </p>
      ))}
      <form onSubmit={submit} className="relationship-form">
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={`canonical-${ticket.id}`}>
              Canonical ticket reference
            </FieldLabel>
            <div className="relationship-input">
              <Input
                id={`canonical-${ticket.id}`}
                value={canonical}
                onChange={(event) => setCanonical(event.target.value)}
                required
                aria-invalid={!!error}
              />
              <Button type="submit" variant="outline" disabled={pending}>
                Mark duplicate
              </Button>
            </div>
            <FieldError>{error}</FieldError>
          </Field>
        </FieldGroup>
      </form>
    </section>
  );
}

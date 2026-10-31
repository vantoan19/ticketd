import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { client, type Ticket } from "@/lib/api/client";

type Related = { reference: string; title: string; trashed: boolean };
function RelatedTicket({
  item,
  select,
  revision,
}: {
  item: Related;
  select: (reference: string, trashed: boolean) => void;
  revision: number;
}) {
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    void client.showTicket(item.reference).then(
      (ticket) => {
        if (active) setStatus(ticket.status);
      },
      () => {
        if (active) setStatus("Status unavailable");
      },
    );
    return () => {
      active = false;
    };
  }, [item.reference, revision]);
  return (
    <div className="relationship-ticket">
      <Button
        variant="link"
        className="relationship-link"
        onClick={() => select(item.reference, item.trashed)}
      >
        {item.reference} {item.title}
      </Button>
      <p>
        {status || "Loading status…"}
        {item.trashed && " · Trashed"}
      </p>
    </div>
  );
}
export function Hierarchy({
  ticket,
  refresh,
  select,
  revision,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
  select: (reference: string, trashed: boolean) => void;
  revision: number;
}) {
  const [parent, setParent] = useState("");
  const [child, setChild] = useState("");
  const [errorSection, setErrorSection] = useState<"parent" | "child">(
    "parent",
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function change(
    reference: string,
    action: () => Promise<void>,
    section: "parent" | "child" = "parent",
    clearDraft?: () => void,
  ) {
    setErrorSection(section);
    setPending(true);
    setError("");
    try {
      await action();
      clearDraft?.();
      await refresh();
    } catch (reason) {
      setError(`Could not update ${reference}: ${String(reason)}`);
    } finally {
      setPending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change(
      parent,
      () => client.setParent(ticket.reference, parent.trim()),
      "parent",
      () => setParent(""),
    );
  }
  return (
    <>
      <section className="relationship-section" aria-label="Parent">
        <h3>
          Parent <span>{ticket.parent ? 1 : 0}</span>
        </h3>
        {ticket.parent ? (
          <ul className="relationship-list">
            <li>
              <RelatedTicket
                item={ticket.parent}
                select={select}
                revision={revision}
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void change("parent", () =>
                    client.setParent(ticket.reference, null),
                  )
                }
              >
                Remove parent
              </Button>
            </li>
          </ul>
        ) : (
          <p className="relationship-empty">No parent ticket.</p>
        )}
        <form onSubmit={submit} className="relationship-form">
          <FieldGroup>
            <Field data-invalid={errorSection === "parent" && !!error}>
              <FieldLabel htmlFor={`parent-${ticket.id}`}>
                Parent reference
              </FieldLabel>
              <div className="relationship-input">
                <Input
                  id={`parent-${ticket.id}`}
                  value={parent}
                  onChange={(event) => setParent(event.target.value)}
                  required
                  aria-invalid={errorSection === "parent" && !!error}
                />
                <Button variant="outline" type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Set parent"}
                </Button>
              </div>
              <FieldError>{errorSection === "parent" && error}</FieldError>
            </Field>
          </FieldGroup>
        </form>
      </section>
      <section className="relationship-section" aria-label="Subtickets">
        <h3>
          Subtickets <span>{ticket.children.length}</span>
        </h3>
        {ticket.children.length === 0 ? (
          <p className="relationship-empty">No subtickets yet.</p>
        ) : (
          <ul className="relationship-list">
            {ticket.children.map((child) => (
              <li key={child.reference}>
                <RelatedTicket
                  item={child}
                  select={select}
                  revision={revision}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void change(
                      child.reference,
                      () =>
                        client.detachChild(child.reference, ticket.reference),
                      "child",
                    )
                  }
                >
                  Remove {child.reference}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void change(
              child,
              () => client.setParent(child.trim(), ticket.reference),
              "child",
              () => setChild(""),
            );
          }}
          className="relationship-form"
        >
          <FieldGroup>
            <Field data-invalid={errorSection === "child" && !!error}>
              <FieldLabel htmlFor={`child-${ticket.id}`}>
                Subticket reference
              </FieldLabel>
              <div className="relationship-input">
                <Input
                  id={`child-${ticket.id}`}
                  value={child}
                  onChange={(event) => setChild(event.target.value)}
                  required
                  aria-invalid={errorSection === "child" && !!error}
                />
                <Button variant="outline" type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Add subticket"}
                </Button>
              </div>
              <FieldError>{errorSection === "child" && error}</FieldError>
            </Field>
          </FieldGroup>
        </form>
      </section>
    </>
  );
}

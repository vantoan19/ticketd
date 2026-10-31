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

type Links = Awaited<ReturnType<typeof client.contextualRelationships>>;
type Kind = "related" | "discovered" | "discovered_while";
export function ContextualRelationships({
  ticket,
  refresh,
  revision,
  select,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
  revision: number;
  select: (reference: string) => void;
}) {
  const [links, setLinks] = useState<Links | null>(null);
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState<Kind>("related");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<{ key: string; id: string } | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    client
      .contextualRelationships(ticket.reference, offset)
      .then((value) => {
        if (active) setLinks(value);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [ticket.reference, offset, revision]);
  async function change(
    source: string,
    destination: string,
    relation: "related" | "discovered",
    add: boolean,
  ) {
    const key = JSON.stringify([source, destination, relation, add]);
    const id = attempt?.key === key ? attempt.id : crypto.randomUUID();
    setAttempt({ key, id });
    setPending(true);
    setError("");
    try {
      await client.changeContextualRelationship(
        source,
        destination,
        relation,
        add,
        id,
      );
      setAttempt(null);
      setTarget("");
      setLinks(await client.contextualRelationships(ticket.reference, offset));
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change(
      kind === "discovered_while" ? target.trim() : ticket.reference,
      kind === "discovered_while" ? ticket.reference : target.trim(),
      kind === "related" ? "related" : "discovered",
      true,
    );
  }
  const groups = links
    ? [
        {
          label: "Related to",
          page: links.related,
          relation: "related" as const,
          reverse: false,
        },
        {
          label: "Discovered while working on",
          page: links.discovered_while,
          relation: "discovered" as const,
          reverse: true,
        },
        {
          label: "Discovered during this work",
          page: links.discoveries,
          relation: "discovered" as const,
          reverse: false,
        },
      ]
    : [];
  return (
    <section
      className="relationship-section"
      aria-label="Contextual relationships"
    >
      <h3>Contextual relationships</h3>
      {groups.map((group) => (
        <div key={group.label}>
          <h4>{group.label}</h4>
          <ul className="relationship-list">
            {group.page.items.map((item) => (
              <li key={item.reference}>
                <div className="relationship-ticket">
                  <Button
                    variant="link"
                    className="relationship-link"
                    onClick={() => select(item.reference)}
                  >
                    {item.reference} {item.title.text}
                  </Button>
                  <p>
                    {item.status}
                    {item.trashed && " · Trashed"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void change(
                      group.reverse ? item.reference : ticket.reference,
                      group.reverse ? ticket.reference : item.reference,
                      group.relation,
                      false,
                    )
                  }
                >
                  Remove {item.reference}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {offset > 0 && (
        <Button
          variant="outline"
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          Previous relationships
        </Button>
      )}
      {groups.some((group) => group.page.next_offset !== null) && (
        <Button variant="outline" onClick={() => setOffset(offset + 20)}>
          More relationships
        </Button>
      )}
      <form onSubmit={submit} className="relationship-form">
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={`context-target-${ticket.id}`}>
              Ticket reference
            </FieldLabel>
            <div className="relationship-input">
              <Input
                id={`context-target-${ticket.id}`}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                required
                aria-invalid={!!error}
              />
              <label>
                Relationship{" "}
                <select
                  value={kind}
                  onChange={(event) =>
                    setKind(
                      event.target.value === "discovered"
                        ? "discovered"
                        : event.target.value === "discovered_while"
                          ? "discovered_while"
                          : "related",
                    )
                  }
                >
                  <option value="related">Related to</option>
                  <option value="discovered_while">
                    Discovered while working on
                  </option>
                  <option value="discovered">
                    Discovered during this work
                  </option>
                </select>
              </label>
              <Button type="submit" variant="outline" disabled={pending}>
                Add relationship
              </Button>
            </div>
            <FieldError>{error}</FieldError>
          </Field>
        </FieldGroup>
      </form>
    </section>
  );
}

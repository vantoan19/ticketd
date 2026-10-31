import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  client,
  type Ticket,
  type DuplicatePreview,
  type DependencyDecision,
} from "@/lib/api/client";

export function Duplicates({
  ticket,
  refresh,
  select,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
  select: (reference: string) => void;
}) {
  const [editingGraph, setEditingGraph] = useState(false);
  const [existingEndpoint, setExistingEndpoint] = useState("");
  const [canonical, setCanonical] = useState("");
  const [preview, setPreview] = useState<DuplicatePreview | null>(null);
  const [choices, setChoices] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<{ key: string; id: string } | null>(
    null,
  );
  async function save(target: string | null) {
    const key =
      target === null
        ? "remove"
        : JSON.stringify({
            target,
            preview,
            choices,
            editingGraph,
            existingEndpoint,
          });
    const id = attempt?.key === key ? attempt.id : crypto.randomUUID();
    setAttempt({ key, id });
    setPending(true);
    setError("");
    try {
      if (target === null) await client.removeDuplicate(ticket.reference, id);
      else if (preview) {
        const decisions: DependencyDecision[] = preview.edges.map(
          (edge, index) => ({
            edge,
            choice: choices[index] as DependencyDecision["choice"],
          }),
        );
        if (editingGraph)
          await client.editDependenciesReviewed(
            existingEndpoint.trim(),
            ticket.reference,
            preview.canonical,
            decisions,
            id,
          );
        else
          await client.markDuplicateReviewed(
            ticket.reference,
            target,
            preview.canonical,
            decisions,
            id,
          );
      }
      setAttempt(null);
      setCanonical("");
      setPreview(null);
      setChoices([]);
      await refresh();
    } catch (reason) {
      setError(String(reason));
      if (String(reason).includes("review has changed")) setPreview(null);
    } finally {
      setPending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    void client
      .previewDuplicate(
        editingGraph ? existingEndpoint.trim() : ticket.reference,
        editingGraph ? ticket.reference : canonical.trim(),
      )
      .then((result) => {
        setPreview(result);
        setChoices(result.edges.map(() => ""));
      })
      .catch((reason: unknown) => setError(String(reason)))
      .finally(() => setPending(false));
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
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setEditingGraph(!editingGraph);
          setPreview(null);
          setError("");
        }}
      >
        {editingGraph
          ? "Mark a duplicate"
          : "Review separate dependency changes"}
      </Button>
      <form onSubmit={submit} className="relationship-form">
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={`canonical-${ticket.id}`}>
              {editingGraph
                ? "Existing endpoint to replace"
                : "Canonical ticket reference"}
            </FieldLabel>
            <div className="relationship-input">
              <Input
                id={`canonical-${ticket.id}`}
                value={editingGraph ? existingEndpoint : canonical}
                onChange={(event) => {
                  if (editingGraph) setExistingEndpoint(event.target.value);
                  else setCanonical(event.target.value);
                  setPreview(null);
                }}
                required
                aria-invalid={!!error}
              />
              <Button type="submit" variant="outline" disabled={pending}>
                Preview dependencies
              </Button>
            </div>
            <FieldError>{error}</FieldError>
          </Field>
        </FieldGroup>
      </form>
      {preview && (
        <div>
          <p>Canonical ticket: {preview.canonical}</p>
          {preview.edges.map((edge, index) => (
            <p key={`${edge.blocker}-${edge.dependent}`}>
              {edge.blocker} blocks {edge.dependent}. Replacement:{" "}
              {edge.replacement_blocker} blocks {edge.replacement_dependent}.
              <label>
                Choice for {edge.blocker} blocks {edge.dependent}
                <select
                  value={choices[index] ?? ""}
                  onChange={(event) =>
                    setChoices((current) =>
                      current.map((choice, i) =>
                        i === index ? event.target.value : choice,
                      ),
                    )
                  }
                >
                  <option value="">Choose</option>
                  <option value="replace">Replace</option>
                  <option value="remove">Remove</option>
                  <option value="retain">
                    Retain (a canceled blocker remains unresolved)
                  </option>
                </select>
              </label>
            </p>
          ))}
          <Button
            disabled={pending || choices.some((choice) => !choice)}
            onClick={() =>
              void save(editingGraph ? ticket.reference : canonical.trim())
            }
          >
            {editingGraph ? "Apply dependency changes" : "Mark duplicate"}
          </Button>
        </div>
      )}
    </section>
  );
}

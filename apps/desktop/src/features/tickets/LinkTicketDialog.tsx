import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { Ticket } from "@/lib/api/client";
import { useTicketSearch } from "./useTicketSearch";
import {
  addableKinds,
  addLink,
  type AddableKind,
} from "@/features/tickets/linked-work";

/** One focused flow: choose the relationship and its direction, then the ticket. */
export function LinkTicketDialog({
  ticket,
  open,
  onOpenChange,
  onLinked,
  initialKind,
}: {
  ticket: Ticket;
  /** The relationship the dialog opens on, such as Add subticket's. */
  initialKind?: AddableKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => Promise<void>;
}) {
  const [kind, setKind] = useState<AddableKind>("blocked_by");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Ticket | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setKind(initialKind ?? "blocked_by");
  }

  // A ticket has one parent, so a link that gives it a new parent moves it.
  const replacedParent =
    kind === "parent"
      ? ticket.parent?.reference
      : kind === "subticket"
        ? chosen?.parent?.reference
        : undefined;

  const search = useTicketSearch(
    query,
    open,
    (item) => item.reference !== ticket.reference,
  );
  const { results } = search;

  function change(next: boolean) {
    if (!next) {
      setQuery("");
      search.reset();
      setChosen(null);
      setError("");
      attempt.current = null;
    }
    onOpenChange(next);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen) return;
    const key = JSON.stringify([kind, chosen.reference]);
    const id =
      attempt.current?.key === key ? attempt.current.id : crypto.randomUUID();
    attempt.current = { key, id };
    setPending(true);
    setError("");
    try {
      await addLink(ticket.reference, kind, chosen.reference, id);
      change(false);
      await onLinked();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }
  const visible = query.trim() ? results : [];
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="link-ticket-dialog">
        <DialogHeader>
          <DialogTitle>Link ticket</DialogTitle>
          <DialogDescription>
            Choose how {ticket.reference} relates to another ticket.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`link-kind-${ticket.id}`}>
                Relationship
              </FieldLabel>
              <div className="link-ticket-sentence">
                <span>{ticket.reference}</span>
                <select
                  id={`link-kind-${ticket.id}`}
                  value={kind}
                  onChange={(event) => {
                    setKind(
                      addableKinds.find(
                        (item) => item.kind === event.target.value,
                      )?.kind ?? kind,
                    );
                    setError("");
                  }}
                >
                  {addableKinds.map((item) => (
                    <option key={item.kind} value={item.kind}>
                      {item.phrase}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
            <Field data-invalid={!!(error || search.error)}>
              <FieldLabel htmlFor={`link-search-${ticket.id}`}>
                Ticket
              </FieldLabel>
              {chosen ? (
                <div className="link-ticket-chosen">
                  <StatusIcon status={chosen.status} size={14} decorative />
                  <span>
                    {chosen.reference} {chosen.title}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setChosen(null);
                      setError("");
                    }}
                  >
                    Change ticket
                  </Button>
                </div>
              ) : (
                <>
                  <Input
                    id={`link-search-${ticket.id}`}
                    value={query}
                    placeholder="Search by title, text or T-number"
                    autoComplete="off"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {visible.length > 0 && (
                    <ul className="link-ticket-results" aria-label="Matches">
                      {visible.map((item) => (
                        <li key={item.reference}>
                          <button
                            type="button"
                            onClick={() => {
                              setChosen(item);
                              setError("");
                            }}
                          >
                            <StatusIcon
                              status={item.status}
                              size={14}
                              decorative
                            />
                            <span className="link-ticket-reference">
                              {item.reference}
                            </span>
                            <span>{item.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              <FieldError>{error || search.error}</FieldError>
            </Field>
          </FieldGroup>
          {replacedParent && (
            <p role="status" className="link-ticket-note">
              This replaces the current parent {replacedParent}.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => change(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!chosen || pending}>
              {pending ? "Linking…" : "Link ticket"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

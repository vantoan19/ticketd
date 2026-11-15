import { useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Picker } from "@/components/ui/picker";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { Ticket } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
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
  const [kind, setKind] = useState<AddableKind>("related");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Ticket | null>(null);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setKind(initialKind ?? "related");
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

  // Escape and clicking outside only close the dialog: what was typed or chosen
  // is still there when it reopens. Cancel and a finished link discard it.
  function discard() {
    setQuery("");
    search.reset();
    setChosen(null);
    setError(null);
    attempt.current = null;
  }
  function change(next: boolean) {
    onOpenChange(next);
  }
  const [draftFor, setDraftFor] = useState(ticket.reference);
  if (draftFor !== ticket.reference) {
    setDraftFor(ticket.reference);
    setQuery("");
    setChosen(null);
    setError(null);
  }
  async function submit() {
    if (!chosen) return;
    const key = JSON.stringify([kind, chosen.reference]);
    const id =
      attempt.current?.key === key ? attempt.current.id : crypto.randomUUID();
    attempt.current = { key, id };
    setPending(true);
    setError(null);
    try {
      await addLink(ticket.reference, kind, chosen.reference, id);
      discard();
      change(false);
      await onLinked();
    } catch (reason) {
      setError(describeFailure(reason, `link ${chosen.reference}`));
    } finally {
      setPending(false);
    }
  }
  const visible = query.trim() ? results : [];
  // The title names the button that opened the dialog.
  const title =
    initialKind === "subticket" ? "Add subticket" : "Add relationship";
  return (
    <DialogShell
      open={open}
      onOpenChange={change}
      title={title}
      description={`Choose how ${ticket.reference} relates to another ticket.`}
      primaryLabel={pending ? "Linking…" : "Link ticket"}
      blockedReason={
        pending ? "Linking…" : chosen ? null : "Choose a ticket to link"
      }
      onSubmit={() => void submit()}
      onCancel={discard}
    >
      <div className="link-ticket-dialog flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`link-kind-${ticket.id}`}>
            Relationship
          </FieldLabel>
          <div className="link-ticket-sentence">
            <span>{ticket.reference}</span>
            <Picker
              label="Relationship"
              value={kind}
              onValueChange={(value) => {
                setKind(
                  addableKinds.find((item) => item.kind === value)?.kind ??
                    kind,
                );
                setError(null);
              }}
              options={addableKinds.map((item) => ({
                value: item.kind,
                label: item.phrase,
              }))}
            />
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor={`link-search-${ticket.id}`}>Ticket</FieldLabel>
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
                  setError(null);
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
                placeholder="Search by title, text or reference"
                autoComplete="off"
                aria-invalid={!!search.error || undefined}
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
                          setError(null);
                        }}
                      >
                        <StatusIcon status={item.status} size={14} decorative />
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
          {/* Only the message is in the error colour; the chosen ticket stays neutral. */}
          <FieldError>
            {error
              ? error.code === "cycle"
                ? error.sentence
                : `${error.title}. ${error.sentence}`
              : search.error}
          </FieldError>
        </Field>
        {replacedParent && (
          <Alert tone="attention" size="compact" role="status">
            <AlertDescription>
              This replaces the current parent {replacedParent}.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </DialogShell>
  );
}

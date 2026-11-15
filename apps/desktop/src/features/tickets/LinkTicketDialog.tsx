import { useRef, useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Field, FieldLabel } from "@/components/ui/field";
import { Picker } from "@/components/ui/picker";
import type { Ticket } from "@/lib/api/client";
import { TicketPicker } from "./TicketPicker";
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
  const [error, setError] = useState("");
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

  // Escape and clicking outside only close the dialog: what was typed or chosen
  // is still there when it reopens. Cancel and a finished link discard it.
  function discard() {
    setQuery("");
    setChosen(null);
    setError("");
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
    setError("");
  }
  async function submit() {
    if (!chosen) return;
    const key = JSON.stringify([kind, chosen.reference]);
    const id =
      attempt.current?.key === key ? attempt.current.id : crypto.randomUUID();
    attempt.current = { key, id };
    setPending(true);
    setError("");
    try {
      await addLink(ticket.reference, kind, chosen.reference, id);
      discard();
      change(false);
      await onLinked();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }
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
      footerNote={chosen && `${chosen.reference} ${chosen.title}`}
      error={error}
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
                setError("");
              }}
              options={addableKinds.map((item) => ({
                value: item.kind,
                label: item.phrase,
              }))}
            />
          </div>
        </Field>
        <div className="flex flex-col gap-2">
          <span aria-hidden="true">Ticket</span>
          <TicketPicker
            label="Ticket"
            query={query}
            onQueryChange={setQuery}
            autoFocus={false}
            accept={(item) => item.reference !== ticket.reference}
            selected={chosen ? [chosen.reference] : []}
            onPick={(item) => {
              setChosen(item);
              setError("");
            }}
          />
        </div>
        {replacedParent && (
          <p role="status" className="link-ticket-note">
            This replaces the current parent {replacedParent}.
          </p>
        )}
      </div>
    </DialogShell>
  );
}

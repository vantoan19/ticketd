import { useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import { FieldError } from "@/components/ui/field";
import { Reference } from "@/components/ui/reference";
import { Picker } from "@/components/ui/picker";
import type { Ticket } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
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

  // Escape and clicking outside only close the dialog: what was typed or chosen
  // is still there when it reopens. Cancel and a finished link discard it.
  function discard() {
    setQuery("");
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
  return (
    <DialogShell
      open={open}
      onOpenChange={change}
      // Neutral: the sentence below says which relationship, and it can change.
      title="Link a ticket"
      primaryLabel={pending ? "Linking…" : "Link ticket"}
      blockedReason={
        pending ? "Linking…" : chosen ? null : "Choose a ticket to link"
      }
      footerNote={chosen && `${chosen.reference} ${chosen.title}`}
      // A loop is about the chosen ticket and reads under it; any other
      // failure sits above the footer, where Link ticket retries.
      error={
        error &&
        error.code !== "cycle" && (
          <FailureAlert size="compact" failure={error} />
        )
      }
      onSubmit={() => void submit()}
      onCancel={discard}
    >
      <div className="link-ticket-dialog flex flex-col gap-4">
        {/* One sentence: "T-FV1 [is related to ▾]", then the ticket. */}
        <div className="link-ticket-sentence">
          <Reference>{ticket.reference}</Reference>
          <Picker
            inSentence
            label="Relationship"
            value={kind}
            onValueChange={(value) => {
              setKind(
                addableKinds.find((item) => item.kind === value)?.kind ?? kind,
              );
              setError(null);
            }}
            options={addableKinds.map((item) => ({
              value: item.kind,
              label: item.phrase,
            }))}
          />
        </div>
        <div className="flex flex-col gap-2">
          <TicketPicker
            label="Ticket"
            query={query}
            onQueryChange={setQuery}
            autoFocus
            accept={(item) => item.reference !== ticket.reference}
            selected={chosen ? [chosen.reference] : []}
            onPick={(item) => {
              setChosen(item);
              setError(null);
            }}
          />
          {/* Only the message is in the error colour; the chosen ticket stays neutral. */}
          {error?.code === "cycle" && <FieldError>{error.sentence}</FieldError>}
        </div>
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

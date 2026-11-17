import { useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Duplicates } from "@/features/tickets/Duplicates";
import type { Ticket } from "@/lib/api/client";
import { useTicketChanged } from "./open-ticket";
import { TicketPicker } from "./TicketPicker";

/**
 * The Duplicate group's Add action. A ticket becomes a Duplicate only through
 * the review that names its canonical ticket, so this chooses the ticket and
 * then hands over to that same review, at the same size (md), so the dialog
 * never jumps between steps.
 */
export function MarkDuplicateDialog({
  open,
  onOpenChange,
  onMarked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMarked?: (reference: string) => void;
}) {
  const changed = useTicketChanged();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Ticket | null>(null);
  const [chosen, setChosen] = useState<Ticket | null>(null);

  // Escape closes the dialog and keeps the typed search and chosen ticket for
  // when it reopens; a finished review or Cancel discards them.
  function discard() {
    setQuery("");
    setPicked(null);
    setChosen(null);
  }
  const finish = () => {
    discard();
    onOpenChange(false);
  };
  if (chosen && open)
    return (
      <Duplicates
        ticket={chosen}
        refresh={changed}
        open={open}
        // Escape keeps the typed search and chosen ticket for when it reopens.
        onOpenChange={onOpenChange}
        title={`Mark ${chosen.reference} as a duplicate`}
        description={`${chosen.reference} keeps its description and history and becomes Duplicate. Review what points at it.`}
        onDone={() => {
          onMarked?.(chosen.reference);
          finish();
        }}
        onCancel={finish}
      />
    );
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Mark a ticket as duplicate"
      description="Choose the ticket that duplicates another one. You choose the canonical ticket next."
      primaryLabel="Continue"
      blockedReason={picked ? null : "Choose the ticket to mark."}
      footerNote={picked && `${picked.reference} ${picked.title}`}
      onSubmit={() => setChosen(picked)}
      onCancel={discard}
    >
      <TicketPicker
        label="Ticket to mark"
        query={query}
        onQueryChange={setQuery}
        accept={(item) => !item.trashed && item.status !== "Duplicate"}
        selected={picked ? [picked.reference] : []}
        onPick={setPicked}
      />
    </DialogShell>
  );
}

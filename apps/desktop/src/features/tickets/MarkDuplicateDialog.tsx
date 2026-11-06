import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Duplicates } from "@/features/tickets/Duplicates";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { Ticket } from "@/lib/api/client";
import { useTicketSearch } from "./useTicketSearch";

/**
 * The Duplicate group's Add action. A ticket becomes a Duplicate only through
 * the review that names its canonical ticket, so this chooses the ticket and
 * then hands over to that same review.
 */
export function MarkDuplicateDialog({
  open,
  onOpenChange,
  refresh,
  onMarked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refresh: () => Promise<void>;
  onMarked?: (reference: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Ticket | null>(null);

  const search = useTicketSearch(
    query,
    open,
    (item) => !item.trashed && item.status !== "Duplicate",
  );
  const { results, error } = search;

  // Escape closes the dialog and keeps the typed search and chosen ticket for
  // when it reopens; a finished review discards them.
  function discard() {
    setQuery("");
    search.reset();
    setChosen(null);
  }
  function change(next: boolean) {
    onOpenChange(next);
  }
  const finish = () => {
    discard();
    change(false);
  };
  if (chosen && open)
    return (
      <Duplicates
        ticket={chosen}
        refresh={refresh}
        open={open}
        // Escape keeps the typed search and chosen ticket for when it reopens.
        onOpenChange={change}
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
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="duplicate-dialog">
        <DialogHeader>
          <DialogTitle>Mark a ticket as duplicate</DialogTitle>
          <DialogDescription>
            Choose the ticket that duplicates another one. You choose the
            canonical ticket next.
          </DialogDescription>
        </DialogHeader>
        <div className="duplicate-pick">
          <Field>
            <FieldLabel htmlFor="duplicate-pick-query">
              Ticket to mark
            </FieldLabel>
            <Input
              id="duplicate-pick-query"
              value={query}
              autoComplete="off"
              placeholder="Reference or words from the title"
              aria-invalid={error ? true : undefined}
              onChange={(event) => setQuery(event.target.value)}
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          {query.trim() && results.length === 0 && !error && (
            <p role="status">No tickets to mark match that search.</p>
          )}
          {results.length > 0 && (
            <ul className="duplicate-pick-results" aria-label="Matches">
              {results.map((item) => (
                <li key={item.reference}>
                  <Button
                    variant="ghost"
                    className="duplicate-pick-result"
                    onClick={() => setChosen(item)}
                  >
                    <StatusIcon status={item.status} size={14} decorative />
                    <span className="ticket-ref">{item.reference}</span>
                    <span className="truncate">{item.title}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
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
import { client, type Ticket } from "@/lib/api/client";

const referencePattern = /^t-\d+$/i;

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
  const [results, setResults] = useState<Ticket[]>([]);
  const [chosen, setChosen] = useState<Ticket | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const text = query.trim();
    if (!open || !text) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const lookups: Promise<Ticket[]>[] = [
        client.searchTickets(text, "all", 0),
      ];
      if (referencePattern.test(text))
        lookups.push(
          client.showTicket(text.toUpperCase()).then(
            (found) => [found],
            () => [],
          ),
        );
      void Promise.all(lookups).then(
        (lists) => {
          if (!active) return;
          const seen = new Set<string>();
          setError("");
          setResults(
            lists
              .flat()
              .filter(
                (item) =>
                  !item.trashed &&
                  item.status !== "Duplicate" &&
                  !seen.has(item.reference) &&
                  seen.add(item.reference),
              )
              .slice(0, 8),
          );
        },
        (reason: unknown) => {
          if (active) setError(`Search failed: ${String(reason)}`);
        },
      );
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, open]);

  function change(next: boolean) {
    if (!next) {
      setQuery("");
      setResults([]);
      setChosen(null);
      setError("");
    }
    onOpenChange(next);
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="duplicate-dialog">
        <DialogHeader>
          <DialogTitle>Mark a ticket as duplicate</DialogTitle>
          <DialogDescription>
            {chosen
              ? `Choose the canonical ticket for ${chosen.reference} and review its dependencies.`
              : "Choose the ticket that duplicates another one. You choose the canonical ticket next."}
          </DialogDescription>
        </DialogHeader>
        {chosen ? (
          <Duplicates
            ticket={chosen}
            refresh={refresh}
            onDone={() => {
              onMarked?.(chosen.reference);
              change(false);
            }}
            onCancel={() => setChosen(null)}
          />
        ) : (
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
        )}
      </DialogContent>
    </Dialog>
  );
}

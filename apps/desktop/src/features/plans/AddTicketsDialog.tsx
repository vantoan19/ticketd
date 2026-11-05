import { useEffect, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { Search, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { client, type Ticket } from "@/lib/api/client";
import { plansClient, type Plan } from "@/lib/api/plans";
import type { PlanViewState } from "./usePlanView";

/** Searches existing tickets and adds them to an Plan; a ticket belongs to one Plan. */
export function AddTicketsDialog({
  plan,
  plans,
  open,
  onOpenChange,
  state,
}: {
  plan: Plan;
  plans: Plan[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: PlanViewState;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Ticket[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searches, setSearches] = useState(0);
  const [done, setDone] = useState("");
  const { pending, actionError, run } = state;
  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const text = query.trim();
      // The core's search reads words, so a T-number is looked up directly.
      const exact = /^t-?\d+$/i.test(text)
        ? client.showTicket(`T-${text.replace(/\D+/g, "")}`).then(
            (found) => [found],
            () => [],
          )
        : Promise.resolve([] as Ticket[]);
      void Promise.all([
        exact,
        client.findTickets({
          query,
          project: null,
          unlinked: false,
          plan: null,
          status: null,
          tags: [],
          availability: null,
          family: null,
          limit: 20,
          offset: 0,
        }),
      ]).then(
        ([named, found]) => {
          if (!active) return;
          setSearchError("");
          const seen = new Set<string>();
          setResults(
            [...named, ...found].filter(
              (item) =>
                item.plan_id !== plan.id &&
                !item.trashed &&
                !seen.has(item.reference) &&
                seen.add(item.reference),
            ),
          );
        },
        (reason: unknown) => {
          if (active) setSearchError(String(reason));
        },
      );
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, query, searches, plan.id]);
  const nameOf = (id: string) => plans.find((item) => item.id === id)?.name;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add tickets to {plan.name}</DialogTitle>
          <DialogDescription>
            Search for existing tickets. A ticket already in another Plan moves
            here.
          </DialogDescription>
        </DialogHeader>
        <label className="plan-add-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search tickets to add</span>
          <Input
            type="search"
            placeholder="Search by title or T-number"
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setDone("");
            }}
          />
        </label>
        {(searchError || actionError) && (
          <p role="alert" className="plan-add-error">
            {searchError || actionError}
          </p>
        )}
        {done && (
          <p role="status" className="plan-add-done">
            {done}
          </p>
        )}
        {results && results.length === 0 && !searchError && !done && (
          <EmptyState
            inline
            icon={<SearchX />}
            title="No tickets to add"
            description="Nothing matches this search."
          />
        )}
        <ul className="plan-add-results" aria-label="Tickets to add">
          {(results ?? []).map((ticket) => {
            const from = ticket.plan_id ? nameOf(ticket.plan_id) : null;
            return (
              <li key={ticket.id}>
                <StatusIcon status={ticket.status} />
                <span className="ticket-ref">{ticket.reference}</span>
                <span className="plan-add-title" title={ticket.title}>
                  {ticket.title}
                  {from && <small>In {from}</small>}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  aria-label={`Add ${ticket.reference} to ${plan.name}`}
                  onClick={() =>
                    void run(() =>
                      plansClient.setMember(ticket.reference, plan.id),
                    ).then((added) => {
                      if (!added) return;
                      setDone(
                        from
                          ? `Moved ${ticket.reference} from ${from} to ${plan.name}.`
                          : `Added ${ticket.reference} to ${plan.name}.`,
                      );
                      setSearches((value) => value + 1);
                    })
                  }
                >
                  {from ? "Move here" : "Add"}
                </Button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

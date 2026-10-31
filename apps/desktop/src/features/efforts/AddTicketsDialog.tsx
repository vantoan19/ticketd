import { useEffect, useState } from "react";
import { Search } from "lucide-react";
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
import { effortsClient, type Effort } from "@/lib/api/efforts";
import type { EffortViewState } from "./useEffortView";

/** Searches existing tickets and adds them to an Effort; a ticket belongs to one Effort. */
export function AddTicketsDialog({
  effort,
  efforts,
  open,
  onOpenChange,
  state,
}: {
  effort: Effort;
  efforts: Effort[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: EffortViewState;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Ticket[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searches, setSearches] = useState(0);
  const { pending, actionError, run } = state;
  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = window.setTimeout(() => {
      client
        .findTickets({
          query,
          project: null,
          unlinked: false,
          effort: null,
          status: null,
          tags: [],
          availability: null,
          family: null,
          limit: 20,
          offset: 0,
        })
        .then(
          (found) => {
            if (!active) return;
            setSearchError("");
            setResults(found.filter((item) => item.effort_id !== effort.id));
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
  }, [open, query, searches, effort.id]);
  const nameOf = (id: string) => efforts.find((item) => item.id === id)?.name;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add tickets to {effort.name}</DialogTitle>
          <DialogDescription>
            Search for existing tickets. A ticket already in another Effort
            moves here.
          </DialogDescription>
        </DialogHeader>
        <label className="effort-add-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search tickets to add</span>
          <Input
            type="search"
            placeholder="Search tickets to add"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {(searchError || actionError) && (
          <p role="alert" className="effort-add-error">
            {searchError || actionError}
          </p>
        )}
        {results && results.length === 0 && !searchError && (
          <p className="effort-note">No tickets to add match this search.</p>
        )}
        <ul className="effort-add-results" aria-label="Tickets to add">
          {(results ?? []).map((ticket) => {
            const from = ticket.effort_id ? nameOf(ticket.effort_id) : null;
            return (
              <li key={ticket.id}>
                <StatusIcon status={ticket.status} />
                <span className="ticket-ref">{ticket.reference}</span>
                <span className="effort-add-title" title={ticket.title}>
                  {ticket.title}
                  {from && <small>In {from}</small>}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  aria-label={`Add ${ticket.reference} to ${effort.name}`}
                  onClick={() =>
                    void run(() =>
                      effortsClient.setMember(ticket.reference, effort.id),
                    ).then((added) => {
                      if (added) setSearches((value) => value + 1);
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

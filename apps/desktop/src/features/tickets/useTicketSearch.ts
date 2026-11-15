import { useEffect, useEffectEvent, useState } from "react";
import { client, type Ticket } from "@/lib/api/client";
import { failureText } from "@/lib/api/describe-failure";
import { typedReference } from "./ticket-references";

const MATCHES = 8;
const DELAY_MS = 150;

/**
 * Looks tickets up for a picker as the person types: the core's search plus an
 * exact reference such as T-KQ12, de-duplicated and trimmed to a short list.
 * `accept` says which tickets may be offered at all.
 */
export function useTicketSearch(
  query: string,
  open: boolean,
  accept: (ticket: Ticket) => boolean,
) {
  const [results, setResults] = useState<Ticket[]>([]);
  const [error, setError] = useState("");
  const keep = useEffectEvent(accept);
  useEffect(() => {
    const text = query.trim();
    if (!open || !text) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const lookups: Promise<Ticket[]>[] = [
        client.searchTickets(text, "all", 0),
      ];
      // An exact reference is what was asked for, so it leads the list.
      if (typedReference.test(text))
        lookups.unshift(
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
                  keep(item) &&
                  !seen.has(item.reference) &&
                  seen.add(item.reference),
              )
              .slice(0, MATCHES),
          );
        },
        (reason: unknown) => {
          if (active) setError(failureText(reason, "search tickets"));
        },
      );
    }, DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, open]);
  return {
    results,
    error,
    reset() {
      setResults([]);
      setError("");
    },
  };
}

import { useEffect, useEffectEvent, useState } from "react";
import { client, type Ticket } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
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
  const [found, setFound] = useState<{ query: string; items: Ticket[] }>({
    query: "",
    items: [],
  });
  const [resolvedQuery, setResolvedQuery] = useState("");
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
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
          setResolvedQuery(text);
          setFailure(null);
          setFound({
            query: text,
            items: lists
              .flat()
              .filter(
                (item) =>
                  keep(item) &&
                  !seen.has(item.reference) &&
                  seen.add(item.reference),
              )
              .slice(0, MATCHES),
          });
        },
        (reason: unknown) => {
          if (active) {
            setResolvedQuery(text);
            setFailure(describeFailure(reason, "search tickets"));
          }
        },
      );
    }, DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, open, attempt]);
  return {
    results: found.query === query.trim() ? found.items : [],
    error:
      resolvedQuery === query.trim() && failure
        ? `${failure.title}. ${failure.sentence}`
        : "",
    failure: resolvedQuery === query.trim() ? failure : null,
    retry: () => setAttempt((count) => count + 1),
    reset() {
      setFound({ query: "", items: [] });
      setFailure(null);
    },
  };
}

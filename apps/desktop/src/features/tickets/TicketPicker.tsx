import { useState } from "react";
import { ChoiceList } from "@/components/ui/choice-list";
import type { Ticket } from "@/lib/api/client";
import { StatusIcon } from "./StatusIcon";
import { useTicketSearch } from "./useTicketSearch";

/**
 * The one way to find a ticket (DESIGN.md section 11, P3): a search row
 * ("Search tickets by title or reference") over a fixed list of six 36px
 * rows of StatusIcon, reference, truncating title and a trailing caption
 * ("Linked", "In Trash"). An exact reference such as T-KQ12 is looked up
 * directly and leads the list; typing is debounced by 150ms.
 *
 * - Single pick: `onPick` receives the ticket; the caller closes or moves on.
 * - Multi pick (`selected`): rows toggle and wear a check; the caller's
 *   dialog puts the count in its note slot and adds them with its primary.
 *
 * Place it in a DialogShell body or a PopoverContent.
 */
export function TicketPicker({
  onPick,
  accept = () => true,
  selected,
  caption,
  autoFocus = true,
  label = "Tickets",
}: {
  onPick: (ticket: Ticket) => void;
  /** Which tickets may be offered at all (not the ticket itself, say). */
  accept?: (ticket: Ticket) => boolean;
  /** Multi pick: the references chosen so far. */
  selected?: readonly string[];
  /** A short trailing word for a row: "Linked", "In Trash", "Already in this Plan". */
  caption?: (ticket: Ticket) => string | undefined;
  autoFocus?: boolean;
  /** Names the list for assistive technology. */
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const search = useTicketSearch(query, true, accept);
  const typed = query.trim();
  const results = typed ? search.results : [];
  return (
    <ChoiceList
      label={label}
      searchPlaceholder="Search tickets by title or reference"
      autoFocus={autoFocus}
      query={query}
      onQueryChange={setQuery}
      size="tall"
      rows={6}
      groups={results.map((ticket) => {
        const meta = caption?.(ticket);
        return {
          value: ticket.reference,
          label: ticket.title,
          reference: ticket.reference,
          icon: <StatusIcon status={ticket.status} decorative />,
          ...(meta && { meta }),
        };
      })}
      {...(selected && { selected })}
      onSelect={(reference) => {
        const ticket = results.find((item) => item.reference === reference);
        if (ticket) onPick(ticket);
      }}
      {...(search.error && { notice: search.error })}
      empty={(text) =>
        text
          ? `No tickets match “${text}”`
          : "Type part of a title, or a reference such as T-KQ12."
      }
    />
  );
}

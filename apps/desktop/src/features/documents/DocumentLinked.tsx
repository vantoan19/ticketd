import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reference } from "@/components/ui/reference";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { DocumentSummary } from "./api";

/**
 * What a Document belongs to: its Plans (Archived ones included, each with the Document's role in
 * it) and its tickets with their status. The same list serves the end of a Document and, later,
 * a side rail; it says nothing when there is nothing to list.
 */
export function LinkedItems({
  plans,
  tickets,
  onOpenPlan,
  onOpenTicket,
}: {
  plans: NonNullable<DocumentSummary["plans"]>;
  tickets: NonNullable<DocumentSummary["tickets"]>;
  onOpenPlan?: ((id: string) => void) | undefined;
  onOpenTicket?: ((reference: string) => void) | undefined;
}) {
  if (plans.length + tickets.length === 0) return null;
  return (
    <ul className="document-linked-items">
      {plans.map((plan) => (
        <li key={plan.id}>
          <Button variant="ghost" onClick={() => onOpenPlan?.(plan.id)}>
            <Layers aria-hidden="true" />
            <span className="connected-label">
              {plan.name}
              <span className="document-linked-role">
                {" "}
                · {plan.spec ? "spec" : "supporting"}
                {plan.archived && " · archived"}
              </span>
            </span>
          </Button>
        </li>
      ))}
      {tickets.map((ticket) => (
        <li key={ticket.reference}>
          <Button
            variant="ghost"
            onClick={() => onOpenTicket?.(ticket.reference)}
          >
            <StatusIcon status={ticket.status} />
            <span className="connected-label">
              <Reference>{ticket.reference}</Reference> {ticket.title}
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

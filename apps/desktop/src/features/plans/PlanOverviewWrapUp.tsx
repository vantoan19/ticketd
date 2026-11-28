import { useId, useState } from "react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TicketPropertyChoices } from "@/features/tickets/TicketCommandPicker";
import { client, type Ticket } from "@/lib/api/client";
import type { Plan, View } from "@/lib/api/plans";
import { plural } from "@/lib/format";
import { planAssignmentChoices } from "./plan-assignment";
import { planWrapUp } from "./plan-work-model";
import {
  useArchivePlan,
  usePlanAction,
  type PlanViewState,
} from "./usePlanView";

export function PlanOverviewWrapUp({
  view,
  plans,
  state,
}: {
  view: View;
  plans: readonly Plan[];
  state: PlanViewState;
}) {
  const titleId = useId();
  const archive = useArchivePlan(view.plan, state);
  const remaining = planWrapUp(view.plan.archived, view.members);
  if (remaining === null) return null;

  const first = remaining[0];
  let description = "Every ticket is done.";
  if (first)
    description =
      remaining.length === 1
        ? `Only ${first.reference} is left, blocked by another Plan.`
        : `${remaining.length} tickets are left, blocked by other Plans.`;

  return (
    <Alert role="region" aria-labelledby={titleId}>
      <AlertTitle id={titleId} level={2}>
        Ready to wrap up
      </AlertTitle>
      <AlertDescription>{description}</AlertDescription>
      <AlertActions>
        {first && (
          <MoveRemainingTickets
            current={view.plan}
            plans={plans}
            state={state}
            references={remaining.map((ticket) => ticket.reference)}
            subject={
              remaining.length === 1
                ? first.reference
                : plural(remaining.length, "ticket")
            }
          />
        )}
        <Button size="sm" disabled={state.pending} onClick={archive}>
          Archive Plan
        </Button>
      </AlertActions>
    </Alert>
  );
}

function MoveRemainingTickets({
  current,
  plans,
  state,
  references,
  subject,
}: {
  current: Plan;
  plans: readonly Plan[];
  state: PlanViewState;
  references: string[];
  subject: string;
}) {
  const [open, setOpen] = useState(false);
  const act = usePlanAction(state);

  function move(destination: string) {
    setOpen(false);
    if (destination === current.id || state.pending) return;

    const name = plans.find((plan) => plan.id === destination)?.name;
    const moveTickets = batchMove(
      references,
      destination || null,
      state.reload,
    );
    const restoreTickets = batchMove(references, current.id, state.reload);
    void act(moveTickets, `move ${subject}`, {
      message: name
        ? `Moved ${subject} to ${name}`
        : `Removed ${subject} from ${current.name}`,
      undo: () => state.apply(restoreTickets),
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={state.pending}>
          Move {subject}…
        </Button>
      </PopoverTrigger>
      <PopoverContent
        variant="constrained-list"
        align="start"
        aria-label="Plan choices"
      >
        <TicketPropertyChoices
          scope="Plan"
          options={planAssignmentChoices(plans, current.id)}
          selected={current.id}
          disabled={state.pending}
          onSelect={move}
        />
      </PopoverContent>
    </Popover>
  );
}

// The core accepts at most 100 edits per batch. Retry skips acknowledged
// batches and reuses the ID when a write's reply may have been lost.
function batchMove(
  references: string[],
  planId: string | null,
  reload: () => void,
) {
  const pending: { references: string[]; requestId: string }[] = [];
  const batchSize = 100;
  for (let start = 0; start < references.length; start += batchSize) {
    pending.push({
      references: references.slice(start, start + batchSize),
      requestId: crypto.randomUUID(),
    });
  }
  return async () => {
    const moved: Ticket[] = [];
    try {
      for (let batch = pending[0]; batch; batch = pending[0]) {
        moved.push(
          ...(await client.bulkChange(
            batch.references,
            { plan_id: planId },
            batch.requestId,
          )),
        );
        pending.shift();
      }
      return moved;
    } catch (reason) {
      reload();
      throw reason;
    }
  };
}

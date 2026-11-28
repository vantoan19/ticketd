import { useId, useState } from "react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TicketPropertyChoices } from "@/features/tickets/TicketCommandPicker";
import { client, type Ticket } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";
import type { Plan, View } from "@/lib/api/plans";
import { plural } from "@/lib/format";
import { planAssignmentChoices } from "./plan-assignment";
import { planWrapUp } from "./plan-work-model";
import { useArchivePlan, type PlanViewState } from "./usePlanView";

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
  const statusLine = useStatusLine();

  function move(destination: string) {
    setOpen(false);
    if (destination === current.id || state.pending) return;

    const name = plans.find((plan) => plan.id === destination)?.name;
    const moveTickets = batchMove(references, destination || null);

    async function finishMove() {
      await state.apply(moveTickets.write);
      const confirmed = moveTickets.confirmed;
      const restore = confirmed.length
        ? batchMove(
            confirmed.map((ticket) => ticket.reference),
            current.id,
          )
        : null;
      const undo = restore
        ? async () => {
            await state.apply(restore.write);
            const problem = restore.failure();
            if (problem) throw problem.reason;
          }
        : undefined;
      const problem = moveTickets.failure();
      if (!problem) {
        statusLine.show({
          message: name
            ? `Moved ${subject} to ${name}`
            : `Removed ${subject} from ${current.name}`,
          ...(undo && { undo }),
        });
        return;
      }

      const failure = describeFailure(problem.reason, `move ${subject}`);
      const retry = failure.action === "retry";
      statusLine.show({
        tone: "error",
        message: confirmed.length
          ? `Confirmed ${confirmed.length} of ${references.length} tickets moved. Couldn't confirm the rest.`
          : `${failure.title}. ${failure.sentence}`,
        details: failure.details,
        ...(retry && { action: { label: "Retry", run: finishMove } }),
        ...(undo &&
          (retry
            ? { secondaryAction: { label: "Undo", run: undo } }
            : { undo })),
      });
    }

    void finishMove();
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
function batchMove(references: string[], planId: string | null) {
  const pending: { references: string[]; requestId: string }[] = [];
  const batchSize = 100;
  for (let start = 0; start < references.length; start += batchSize) {
    pending.push({
      references: references.slice(start, start + batchSize),
      requestId: crypto.randomUUID(),
    });
  }
  const confirmed: Ticket[] = [];
  let problem: { reason: unknown } | null = null;

  return {
    confirmed,
    failure: () => problem,
    async write() {
      const from = confirmed.length;
      problem = null;
      try {
        for (let batch = pending[0]; batch; batch = pending[0]) {
          confirmed.push(
            ...(await client.bulkChange(
              batch.references,
              { plan_id: planId },
              batch.requestId,
            )),
          );
          pending.shift();
        }
      } catch (reason) {
        problem = { reason };
      }
      // Report acknowledged writes even while the remaining batch awaits Retry.
      return confirmed.slice(from);
    },
  };
}

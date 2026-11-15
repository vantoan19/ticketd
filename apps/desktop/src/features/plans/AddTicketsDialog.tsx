import { useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import { TicketPicker } from "@/features/tickets/TicketPicker";
import type { Ticket } from "@/lib/api/client";
import { plansClient, type Plan } from "@/lib/api/plans";
import { useStatusLine } from "@/components/ui/use-status-line";
import { plural } from "@/lib/format";
import type { PlanViewState } from "./usePlanView";

/**
 * Finds existing tickets and adds them to a Plan (DESIGN.md section 11): a
 * multi-pick TicketPicker, the count in the footer note and one constant
 * "Add tickets" primary. A ticket belongs to one Plan, so one already in
 * another Plan says so in its row and moves here.
 */
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
  const [picked, setPicked] = useState<Ticket[]>([]);
  // Adding failed while this dialog was open: the cause stays in it.
  const [failed, setFailed] = useState(false);
  const { pending, actionError, run } = state;
  const statusLine = useStatusLine();
  const nameOf = (id: string) => plans.find((item) => item.id === id)?.name;
  const discard = () => {
    setQuery("");
    setPicked([]);
    setFailed(false);
  };
  const count = picked.length;
  const moving = picked.filter((ticket) => ticket.plan_id).length;
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={`Add tickets to ${plan.name}`}
      description="A ticket already in another Plan moves here."
      primaryLabel="Add tickets"
      blockedReason={
        pending ? "Adding…" : count ? null : "Choose tickets to add."
      }
      footerNote={`${count} selected${moving ? `, ${moving} from another Plan` : ""}.`}
      busy={pending}
      error={
        failed &&
        actionError && <FailureAlert size="compact" failure={actionError} />
      }
      onCancel={discard}
      onSubmit={() => {
        const chosen = picked;
        void run(async () => {
          for (const ticket of chosen)
            await plansClient.setMember(ticket.reference, plan.id);
        }, `add tickets to ${plan.name}`).then((added) => {
          setFailed(!added);
          if (!added) return;
          discard();
          onOpenChange(false);
          // Undo puts each ticket back where it was, another Plan or none.
          statusLine.show({
            message: `Added ${chosen.length === 1 ? chosen[0]?.reference : plural(chosen.length, "ticket")} to ${plan.name}`,
            undo: () =>
              state.apply(async () => {
                for (const ticket of chosen)
                  await plansClient.setMember(ticket.reference, ticket.plan_id);
              }),
          });
        });
      }}
    >
      <TicketPicker
        label="Tickets to add"
        query={query}
        onQueryChange={setQuery}
        accept={(ticket) => ticket.plan_id !== plan.id && !ticket.trashed}
        selected={picked.map((ticket) => ticket.reference)}
        caption={(ticket) => {
          const from = ticket.plan_id && nameOf(ticket.plan_id);
          return from ? `In ${from}` : undefined;
        }}
        onPick={(ticket) =>
          setPicked((current) =>
            current.some((item) => item.reference === ticket.reference)
              ? current.filter((item) => item.reference !== ticket.reference)
              : [...current, ticket],
          )
        }
      />
    </DialogShell>
  );
}

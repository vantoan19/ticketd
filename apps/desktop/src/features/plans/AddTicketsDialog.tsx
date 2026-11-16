import { useRef, useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import { TicketPicker } from "@/features/tickets/TicketPicker";
import { client, type Ticket } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";
import { type Plan } from "@/lib/api/plans";
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
  const request = useRef<{ key: string; id: string } | null>(null);
  async function add() {
    if (pending || !picked.length) return;
    const chosen = picked.map((ticket) => ({ ...ticket }));
    const references = chosen.map((ticket) => ticket.reference);
    const key = JSON.stringify([plan.id, [...references].sort()]);
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    const requestId = request.current.id;
    let committed = false;
    const refreshed = await run(async () => {
      await client.bulkChange(references, { plan_id: plan.id }, requestId);
      committed = true;
    }, `add tickets to ${plan.name}`);
    const added = refreshed || committed;
    setFailed(!added);
    if (!added) return;
    discard();
    request.current = null;
    onOpenChange(false);
    // One atomic request adds the selection. Undo may need several original
    // Plans; completed groups are removed so Retry cannot overwrite them later.
    const groups = new Map<string | null, string[]>();
    for (const ticket of chosen)
      groups.set(ticket.plan_id, [
        ...(groups.get(ticket.plan_id) ?? []),
        ticket.reference,
      ]);
    const remaining = [...groups].map(([planId, members]) => ({
      planId,
      members,
      requestId: crypto.randomUUID(),
    }));
    let restored = 0;
    async function undo() {
      try {
        await state.apply(async () => {
          while (remaining.length) {
            const group = remaining[0]!;
            await client.bulkChange(
              group.members,
              { plan_id: group.planId },
              group.requestId,
            );
            restored += group.members.length;
            remaining.shift();
          }
        });
      } catch (reason) {
        const failure = describeFailure(
          reason,
          "restore the remaining Plan memberships",
        );
        statusLine.show({
          tone: "error",
          message: `${restored} of ${chosen.length} tickets restored. ${failure.title}. Retry continues with the remaining tickets.`,
          details: failure.details,
          action: { label: "Retry", run: undo },
        });
      }
    }
    statusLine.show({
      message: `Added ${chosen.length === 1 ? chosen[0]?.reference : plural(chosen.length, "ticket")} to ${plan.name}`,
      undo,
    });
  }
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
        actionError && (
          <FailureAlert
            size="compact"
            failure={actionError}
            onRetry={() => void add()}
          />
        )
      }
      onCancel={discard}
      onSubmit={() => {
        void add();
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

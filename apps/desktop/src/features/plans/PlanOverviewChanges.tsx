import { useId } from "react";
import { FailureAlert } from "@/components/ui/failure-alert";
import { RecordLink } from "@/components/ui/record-link";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { plansClient, type Plan, type PlanActivity } from "@/lib/api/plans";
import { plainText } from "@/lib/plain-text";
import { usePreferences } from "@/lib/preferences";
import { read, skip, useRead } from "@/lib/workspace-reads";
import "./plan-overview-changes.css";

const planActivityRead = read({
  key: "plan-activity",
  call: (id: string) => plansClient.activity(id, 5),
  failure: "load recent Plan changes",
});

export function PlanOverviewChanges({
  plan,
  selected,
  onOpen,
}: {
  plan: Plan;
  selected: string | null;
  onOpen: (reference: string, trigger: HTMLElement) => void;
}) {
  const { planLastLook } = usePreferences();
  const since = Date.parse(planLastLook[plan.id] ?? "");
  const show = !plan.archived && Number.isFinite(since);
  const { value, failure, retry } = useRead(
    planActivityRead,
    show ? plan.id : skip,
  );
  const heading = useId();
  const changes = value?.filter((event) => Date.parse(event.timestamp) > since);
  if (!show || (!changes?.length && !failure)) return null;
  return (
    <section aria-labelledby={heading}>
      <h2 className="plan-overview-section-heading" id={heading}>
        Since you last looked
      </h2>
      {failure && (
        <FailureAlert size="compact" failure={failure} onRetry={retry} />
      )}
      {!!changes?.length && (
        <ul className="plan-overview-changes">
          {changes.map((event) => (
            <li key={event.reference}>
              <RecordLink
                className="plan-overview-change"
                variant="row"
                reference={event.reference}
                aria-current={selected === event.reference ? "true" : undefined}
                onClick={(click) =>
                  onOpen(event.reference, click.currentTarget)
                }
              >
                <ChangeText event={event} />
              </RecordLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChangeText({ event }: { event: PlanActivity }) {
  switch (event.kind) {
    case "status":
      return (
        <>
          <StatusIcon status={event.to} decorative />
          <span>{event.title}</span>
          <span className="text-muted-foreground">{event.to}</span>
        </>
      );
    case "joined":
      return <span>Joined · {event.title}</span>;
    case "update": {
      const text = plainText(event.brief);
      const first = new Intl.Segmenter(undefined, { granularity: "sentence" })
        .segment(text)
        [Symbol.iterator]()
        .next();
      return (
        <span title={event.title}>
          {first.value?.segment.trim() || event.title}
        </span>
      );
    }
  }
}

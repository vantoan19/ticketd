import { useId, type ReactNode } from "react";
import { Layers } from "lucide-react";
import { Item } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Time } from "@/components/ui/time";
import { usePreferences } from "@/lib/preferences";
import type { Plan } from "@/lib/api/plans";
import { PlanRing } from "./PlanProgress";
import type { PlanIndexData } from "./plan-index-data";

function planStateWords(archived: boolean, { counts, details }: PlanIndexData) {
  if (!counts) return "Plan details unavailable";
  const open = counts.todo + counts.in_progress + counts.in_review;
  if (archived) return open ? `${open} left open` : "All done";
  if (!open && counts.done + counts.canceled + counts.duplicate > 0)
    return "All done · ready to archive";
  if (details?.wrapUp) return "Ready to wrap up";
  const ready = details?.ready ?? 0;
  const blocked = details?.blocked ?? 0;
  const words = [
    [counts.in_review, "in review"],
    [counts.in_progress, "in progress"],
    [ready, "ready"],
    [blocked, "blocked"],
    [counts.todo - ready - blocked, "to do"],
  ] as const;
  return (
    words
      .flatMap(([count, word]) => (count > 0 ? [`${count} ${word}`] : []))
      .join(" · ") || "No tickets yet"
  );
}

export function PlanIndexRow({
  plan,
  data,
  onOpen,
  children,
}: {
  plan: Plan;
  data: PlanIndexData;
  onOpen: () => void;
  children?: ReactNode;
}) {
  const { planLastLook } = usePreferences();
  const { counts, details } = data;
  const open = counts && counts.todo + counts.in_progress + counts.in_review;
  const finished =
    !open && !!counts && counts.done + counts.canceled + counts.duplicate > 0;
  const needsAttention =
    !plan.archived &&
    ((counts?.in_review ?? 0) > 0 || finished || details?.wrapUp);
  const state = planStateWords(plan.archived, data);
  const descriptionId = useId();
  const count = counts ? `${counts.done} of ${counts.done + (open ?? 0)}` : "";
  const unread =
    !plan.archived &&
    !needsAttention &&
    Date.parse(details?.updated ?? "") >
      Date.parse(planLastLook[plan.id] ?? "");
  const description = [
    needsAttention && "Needs attention",
    unread && "Changed since you last looked",
    state,
    count && `${count} done`,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <Item asChild>
      <div
        className="plan-index-row"
        data-archived={plan.archived || undefined}
      >
        <button
          className="plan-index-open"
          type="button"
          aria-label={`Open Plan ${plan.name}`}
          aria-describedby={descriptionId}
          onClick={onOpen}
        />
        <span hidden id={descriptionId}>
          {description}
        </span>
        <span className="plan-index-ring">
          {counts ? (
            <PlanRing name={plan.name} counts={counts} size={20} decorative />
          ) : (
            <Layers size={20} aria-hidden />
          )}
        </span>
        <span className="plan-index-name truncate">{plan.name}</span>
        {count && (
          <span className="plan-index-count tabular-nums">{count}</span>
        )}
        <span className="plan-index-state text-muted-foreground">
          {needsAttention && <StatusDot tone="attention" size={6} />}
          {unread && <StatusDot tone="unread" size={6} />}
          <span>{state}</span>
        </span>
        {details?.updated && (
          <span className="plan-index-time text-muted-foreground">
            <Time value={details.updated} />
          </span>
        )}
        {children}
      </div>
    </Item>
  );
}

export function PlanIndexRowSkeleton() {
  return (
    <div className="plan-index-row">
      <div className="plan-index-ring">
        <Skeleton shape="circle" className="size-5" />
      </div>
      <div className="plan-index-name">
        <Skeleton className="h-4 w-36 max-w-full" />
      </div>
      <div className="plan-index-state">
        <Skeleton className="h-3 w-48 max-w-full" />
      </div>
      <div className="plan-index-count">
        <Skeleton className="h-4 w-14" />
      </div>
      <div className="plan-index-time">
        <Skeleton className="h-3 w-10" />
      </div>
    </div>
  );
}

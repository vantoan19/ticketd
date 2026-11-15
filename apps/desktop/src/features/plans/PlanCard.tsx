import {
  Card,
  CardTitle,
  CardCaption,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { ProgressKey } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useContext, useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { type Project, type Ticket } from "@/lib/api/client";
import { plansClient, type Plan, type View } from "@/lib/api/plans";
import { shortcutLabel } from "@/lib/shortcuts";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { DocumentNavigation } from "@/features/documents/navigation";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { Badge } from "@/components/ui/badge";
import { RecordLink } from "@/components/ui/record-link";
import { StatusDot } from "@/components/ui/status-dot";
import { Time } from "@/components/ui/time";
import { Tooltip } from "@/components/ui/tooltip";
import { PlanRing, PlanSplitBar } from "./PlanProgress";
import { allPlanMembers } from "./plan-members";
import { flowOrder } from "./flow-order";

/** Counts never come from the member query: show_plan owns full-Plan progress. */
export function PlanCard({
  plan,
  projects,
  onOpen,
  onTicket,
  children,
}: {
  plan: Plan;
  projects: Project[];
  onOpen: () => void;
  onTicket?: (reference: string) => void;
  children?: React.ReactNode;
}) {
  const [view, setView] = useState<View | null>(null);
  const [members, setMembers] = useState<Ticket[] | null>(null);
  const [failed, setFailed] = useState(false);
  const revision = useWorkspaceChange();
  const openDocument = useContext(DocumentNavigation);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      plansClient.show(plan.id),
      allPlanMembers(plan.id),
    ]).then(([summary, tickets]) => {
      if (!active) return;
      if (summary.status === "fulfilled") setView(summary.value);
      if (tickets.status === "fulfilled") setMembers(tickets.value);
      setFailed(summary.status === "rejected" || tickets.status === "rejected");
    });
    return () => {
      active = false;
    };
  }, [plan.id, revision]);
  const counts = view?.counts;
  const countable =
    counts && counts.todo + counts.in_progress + counts.in_review + counts.done;
  const next =
    members &&
    flowOrder(members).find(
      (member) =>
        member.status === "Todo" &&
        member.availability === "Ready" &&
        !member.source?.unavailable,
    );
  const ready = view?.members.filter(
    (member) => member.status === "Todo" && member.availability === "Ready",
  ).length;
  const blocked = view?.members.filter(
    (member) => member.status === "Todo" && member.availability === "Blocked",
  ).length;
  const projectIds = new Set(
    view?.members.flatMap((member) =>
      member.project_id ? [member.project_id] : [],
    ),
  );
  const project =
    projectIds.size > 1
      ? `${projectIds.size} projects`
      : projects.find((item) => projectIds.has(item.id))?.name;
  const updated = members
    ?.flatMap((member) =>
      member.updated_at && Number.isFinite(Date.parse(member.updated_at))
        ? [member.updated_at]
        : [],
    )
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const spec = view?.documents.find(
    (document) =>
      document.id === view.plan.spec_document_id && !document.trashed,
  );
  return (
    <Card variant="summary" asChild>
      <article className="plan-card" data-archived={plan.archived || undefined}>
        <Tooltip content="Open Plan" shortcut={shortcutLabel("list-open")}>
          <button
            data-slot="card-open"
            className="plan-card-open"
            type="button"
            aria-label={`Open Plan ${plan.name}`}
            onClick={onOpen}
          />
        </Tooltip>
        <div className="plan-card-heading">
          <span className="plan-card-ring-slot">
            {counts ? (
              <PlanRing name={plan.name} counts={counts} size={20} />
            ) : (
              <Skeleton className="size-5" />
            )}
          </span>
          <div className="plan-card-description">
            <div className="plan-card-title">
              <CardTitle asChild>
                <span className="plan-index-name">{plan.name}</span>
              </CardTitle>
              {project && (
                <CardCaption asChild>
                  <span className="plan-card-caption">{project}</span>
                </CardCaption>
              )}
            </div>
            {plan.purpose && (
              <CardDescription asChild>
                <p>{plan.purpose}</p>
              </CardDescription>
            )}
          </div>
          <div className="plan-card-summary">
            {counts ? (
              <strong>
                {counts.done} of {countable} done
              </strong>
            ) : (
              <Skeleton className="h-5 w-24" />
            )}
            {!updated && <Skeleton className="h-4 w-28" />}
            {updated && (
              <CardCaption asChild>
                <span className="plan-card-caption">
                  Updated <Time value={updated} />
                </span>
              </CardCaption>
            )}
          </div>
        </div>
        <div
          className="plan-card-progress-slot"
          data-unavailable={(failed && !counts) || undefined}
          aria-hidden={(failed && !counts) || undefined}
        >
          {counts ? (
            <PlanSplitBar name={plan.name} counts={counts} decorative />
          ) : (
            <Skeleton className="h-1.5 w-full" />
          )}
          <CardCaption asChild>
            <div className="plan-card-legend">
              <ProgressKey segment="done">
                {counts ? counts.done : <Skeleton className="h-3 w-2" />} done
              </ProgressKey>
              <ProgressKey segment="review">
                {counts ? counts.in_review : <Skeleton className="h-3 w-2" />}{" "}
                in review
              </ProgressKey>
              <ProgressKey segment="progress">
                {counts ? counts.in_progress : <Skeleton className="h-3 w-2" />}{" "}
                in progress
              </ProgressKey>
              <ProgressKey segment="todo">
                {counts ? counts.todo : <Skeleton className="h-3 w-2" />} to do
                {ready !== undefined &&
                  blocked !== undefined &&
                  ` · ${ready} ready, ${blocked} blocked`}
              </ProgressKey>
              {counts && counts.canceled > 0 && (
                <span>{counts.canceled} canceled, not counted</span>
              )}
              {counts && counts.duplicate > 0 && (
                <span>
                  {counts.duplicate}{" "}
                  {counts.duplicate === 1 ? "duplicate" : "duplicates"}, not
                  counted
                </span>
              )}
            </div>
          </CardCaption>
        </div>
        <div className="plan-card-footer">
          <CardFooter variant="summary" asChild>
            <div className="plan-card-next">
              <CardCaption asChild>
                <span className="plan-card-caption">Next up</span>
              </CardCaption>
              {next ? (
                <>
                  <StatusIcon status={next.status} decorative />
                  <Tooltip
                    content="Open ticket"
                    shortcut={shortcutLabel("list-open")}
                  >
                    <RecordLink
                      reference={next.reference}
                      onClick={() => onTicket?.(next.reference)}
                    >
                      {next.title}
                    </RecordLink>
                  </Tooltip>
                  <CardCaption asChild>
                    <span className="plan-card-ready">
                      <StatusDot tone="ready" size={6} />
                      Ready
                    </span>
                  </CardCaption>
                </>
              ) : (
                <CardCaption asChild>
                  <span className="plan-card-caption">
                    {members
                      ? "No Ready tickets"
                      : failed
                        ? "Couldn't load next ticket"
                        : "Loading…"}
                  </span>
                </CardCaption>
              )}
              {spec && (
                <Tooltip
                  content="Open spec Document"
                  shortcut={shortcutLabel("list-open")}
                >
                  <Badge variant="doc" tone="raised" asChild>
                    <button
                      type="button"
                      className="plan-card-spec"
                      onClick={() => openDocument?.(spec.id, "Back to Plans")}
                    >
                      <FileText aria-hidden="true" />
                      <span className="truncate">
                        {spec.heading || "Untitled"}
                      </span>
                    </button>
                  </Badge>
                </Tooltip>
              )}
            </div>
          </CardFooter>
          <CardCaption asChild>
            <p className="plan-card-failure" aria-live="polite">
              {failed
                ? "Some Plan details couldn't load. Open the Plan to retry."
                : ""}
            </p>
          </CardCaption>
        </div>
        {children}
      </article>
    </Card>
  );
}

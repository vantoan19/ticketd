import { useContext, useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { client, type Project, type Ticket } from "@/lib/api/client";
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
import { flowOrder } from "./flow-order";

const MEMBER_PAGE = 100;
async function allMembers(plan: string) {
  const members: Ticket[] = [];
  for (let offset = 0; ; offset += MEMBER_PAGE) {
    const page = await client.findTickets({
      query: "",
      unlinked: false,
      project: null,
      plan,
      status: null,
      tags: [],
      availability: null,
      family: null,
      limit: MEMBER_PAGE,
      offset,
    });
    members.push(...page);
    if (page.length < MEMBER_PAGE) return members;
  }
}

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
      allMembers(plan.id),
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
    <article className="plan-card" data-archived={plan.archived || undefined}>
      <Tooltip content="Open Plan" shortcut={shortcutLabel("list-open")}>
        <button
          className="plan-card-open"
          type="button"
          aria-label={`Open Plan ${plan.name}`}
          onClick={onOpen}
        />
      </Tooltip>
      <div className="plan-card-heading">
        {counts && <PlanRing name={plan.name} counts={counts} size={20} />}
        <div className="plan-card-description">
          <div className="plan-card-title">
            <span className="plan-index-name">{plan.name}</span>
            {project && <span className="plan-card-caption">{project}</span>}
          </div>
          {plan.purpose && <p>{plan.purpose}</p>}
        </div>
        <div className="plan-card-summary">
          {counts && (
            <strong>
              {counts.done} of {countable} done
            </strong>
          )}
          {updated && (
            <span className="plan-card-caption">
              Updated <Time value={updated} />
            </span>
          )}
        </div>
      </div>
      {counts && (
        <>
          <PlanSplitBar name={plan.name} counts={counts} decorative />
          <div className="plan-card-legend">
            <span>
              <i data-segment="done" />
              {counts.done} done
            </span>
            <span>
              <i data-segment="review" />
              {counts.in_review} in review
            </span>
            <span>
              <i data-segment="progress" />
              {counts.in_progress} in progress
            </span>
            <span>
              <i data-segment="todo" />
              {counts.todo} to do
              {ready !== undefined &&
                blocked !== undefined &&
                ` · ${ready} ready, ${blocked} blocked`}
            </span>
            {counts.canceled > 0 && (
              <span>{counts.canceled} canceled, not counted</span>
            )}
            {counts.duplicate > 0 && (
              <span>
                {counts.duplicate}{" "}
                {counts.duplicate === 1 ? "duplicate" : "duplicates"}, not
                counted
              </span>
            )}
          </div>
        </>
      )}
      <div className="plan-card-next">
        <span className="plan-card-caption">Next up</span>
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
            <span className="plan-card-ready">
              <StatusDot tone="ready" size={6} />
              Ready
            </span>
          </>
        ) : (
          <span className="plan-card-caption">
            {members
              ? "No Ready tickets"
              : failed
                ? "Couldn't load next ticket"
                : "Loading…"}
          </span>
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
                <span className="truncate">{spec.heading || "Untitled"}</span>
              </button>
            </Badge>
          </Tooltip>
        )}
      </div>
      {failed && (
        <p className="plan-card-caption">
          Some Plan details couldn't load. Open the Plan to retry.
        </p>
      )}
      {children}
    </article>
  );
}

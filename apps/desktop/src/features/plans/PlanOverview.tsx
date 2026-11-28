import {
  useContext,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { FileText, GitPullRequest, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureState } from "@/components/ui/failure-alert";
import { Input } from "@/components/ui/input";
import { RecordLink } from "@/components/ui/record-link";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLineRegion } from "@/components/ui/status-line";
import { Tooltip } from "@/components/ui/tooltip";
import { useStatusLine } from "@/components/ui/use-status-line";
import { DocumentNavigation } from "@/features/documents/navigation";
import type { Project } from "@/lib/api/client";
import { plansClient, type Plan, type View } from "@/lib/api/plans";
import { compactAgo, formatDateTime } from "@/lib/format";
import { matchesShortcut } from "@/lib/shortcuts";
import { PlanDocuments } from "./PlanDocuments";
import { PlanOverviewChanges } from "./PlanOverviewChanges";
import { PlanOverviewFiles } from "./PlanOverviewFiles";
import { PlanOverviewSections } from "./PlanOverviewSections";
import { PlanOverviewStrip } from "./PlanOverviewStrip";
import { PlanOverviewWrapUp } from "./PlanOverviewWrapUp";
import { planWorkModel } from "./plan-work-model";
import { usePlanOverviewFiles } from "./usePlanOverviewFiles";
import { usePlanAction, type PlanViewState } from "./usePlanView";
import "./plan-overview.css";

export type PlanOverviewWork = ReturnType<
  typeof planWorkModel<View["members"][number]>
>;

export function PlanOverview({
  plan,
  plans,
  state,
  work,
  projects,
  selected,
  onOpen,
  paneRef,
}: {
  plan: Plan;
  plans: readonly Plan[];
  state: PlanViewState;
  work: PlanOverviewWork | null;
  projects: readonly Project[];
  selected: string | null;
  onOpen: (reference: string, trigger?: HTMLElement) => void;
  paneRef: RefObject<HTMLElement | null>;
}) {
  const { view, loadError, reload } = state;
  const titleId = useId();
  const openDocument = useContext(DocumentNavigation);
  const current = view?.plan.id === plan.id ? view.plan : plan;
  const files = usePlanOverviewFiles(
    view?.members.length ? plan.id : null,
    work,
  );
  const spec = view?.documents.find(
    (document) => document.id === view.plan.spec_document_id,
  );
  return (
    <section
      className="plan-overview"
      aria-labelledby={titleId}
      onKeyDown={moveBetweenPlanOverviewRows}
      ref={paneRef}
    >
      <StatusLineRegion host={paneRef}>
        <div className="plan-overview-scroll">
          <div className="plan-overview-column">
            <header className="plan-overview-head">
              <h1
                id={titleId}
                className="ui-section-title plan-overview-title"
                tabIndex={-1}
              >
                {current.name}
              </h1>
              <PlanPurpose key={plan.id} plan={current} state={state} />
              {(spec || view?.pull_request) && (
                <div className="plan-overview-links">
                  {spec && (
                    <RecordLink
                      variant="row"
                      onClick={() =>
                        openDocument?.(spec.id, `Back to ${current.name}`)
                      }
                      aria-label={`Spec: ${spec.heading}`}
                    >
                      <FileText aria-hidden="true" />
                      {spec.heading}
                    </RecordLink>
                  )}
                  {view?.pull_request && (
                    <PlanPullRequestLink
                      planId={current.id}
                      url={view.pull_request}
                    />
                  )}
                </div>
              )}
            </header>
            {loadError ? (
              <FailureState failure={loadError} onRetry={reload} />
            ) : view && work ? (
              <>
                {view.members.length > 0 && (
                  <div className="plan-overview-progress">
                    <PlanOverviewProgress view={view} work={work} />
                    <PlanOverviewStrip
                      strip={work.strip}
                      selected={selected}
                      onOpen={onOpen}
                    />
                  </div>
                )}
                <PlanOverviewWrapUp view={view} plans={plans} state={state} />
                {view.members.length > 0 && (
                  <PlanOverviewSections
                    work={work}
                    updates={view.latest_updates}
                    statusSince={view.status_since}
                    projects={projects}
                    selected={selected}
                    onOpen={onOpen}
                    files={files.byTicket}
                    onOpenFiles={files.openGroup}
                  />
                )}
                {/* PlanEmptyState */}
                {view.members.length > 0 && (
                  <PlanOverviewFiles
                    archived={current.archived}
                    state={files}
                    onOpenTicket={onOpen}
                  />
                )}
                {view.members.length > 0 && (
                  <PlanOverviewChanges
                    plan={current}
                    selected={selected}
                    onOpen={onOpen}
                  />
                )}
                <PlanDocuments view={view} state={state} />
              </>
            ) : (
              <div
                className="plan-overview-loading"
                role="status"
                aria-label="Loading Plan"
              >
                <Skeleton className="h-4 w-32" />
                <div className="plan-overview-strip" aria-hidden="true">
                  <Skeleton className="h-2 w-full" />
                </div>
                <div className="plan-overview-loading-rows">
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-4 w-3/5" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              </div>
            )}
          </div>
        </div>
      </StatusLineRegion>
    </section>
  );
}

function PlanPullRequestLink({ planId, url }: { planId: string; url: string }) {
  const statusLine = useStatusLine();
  let number: string | undefined;
  try {
    number = new URL(url).pathname.match(/\/(\d+)\/?$/)?.[1];
  } catch {
    return null;
  }
  return (
    <RecordLink
      variant="row"
      aria-label={number ? `Pull request #${number}` : "Pull request"}
      onClick={() => {
        void plansClient.openPullRequest(planId, url).catch(() => {
          statusLine.show({
            tone: "error",
            message: "Couldn’t open the pull request.",
          });
        });
      }}
    >
      <GitPullRequest aria-hidden="true" />
      {number ? `#${number}` : "Pull request"}
    </RecordLink>
  );
}

function moveBetweenPlanOverviewRows(event: KeyboardEvent<HTMLElement>) {
  const key = event.key.toLowerCase();
  const target = event.target;
  if (
    (key !== "j" && key !== "k") ||
    !matchesShortcut(event, "list-move") ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    !(target instanceof HTMLElement) ||
    target.isContentEditable ||
    target.closest(
      "input, textarea, select, [role=combobox], [role=menu], [role=dialog]",
    )
  )
    return;
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      ".plan-overview-row-open",
    ),
  ].filter((row) => !row.closest("[inert]"));
  const from = rows.findIndex((row) => row.closest("li")?.contains(target));
  const index =
    from === -1
      ? key === "j"
        ? 0
        : rows.length - 1
      : from + (key === "j" ? 1 : -1);
  const next = rows[index];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function PlanOverviewProgress({
  view,
  work,
}: {
  view: View;
  work: PlanOverviewWork;
}) {
  const { counts } = view;
  const words = [
    { count: counts.in_review, label: "in review", status: "review" },
    { count: counts.in_progress, label: "in progress", status: "progress" },
    { count: work.sections.ready.length, label: "ready", status: "ready" },
    {
      count: work.sections.blocked.length,
      label: "blocked",
      status: "blocked",
    },
  ];
  let newest: { timestamp: string; epoch: number } | undefined;
  for (const member of view.members) {
    for (const timestamp of [
      member.updated_at,
      member.latest_update?.reported_at,
    ]) {
      if (!timestamp) continue;
      const epoch = Date.parse(timestamp);
      if (Number.isFinite(epoch) && (!newest || epoch > newest.epoch))
        newest = { timestamp, epoch };
    }
  }
  const age = newest && compactAgo(newest.timestamp);
  const moved =
    age === "now"
      ? "just now"
      : age && /^\d+[mhd]$/.test(age)
        ? `${age} ago`
        : age;
  return (
    <div className="plan-overview-progress-line">
      <span>
        {counts.done} of{" "}
        {counts.done + counts.todo + counts.in_review + counts.in_progress} done
      </span>
      {words.map(
        ({ count, label, status }) =>
          count > 0 && (
            <span className="plan-overview-progress-word" key={status}>
              <span
                className="plan-overview-swatch"
                data-status={status}
                aria-hidden="true"
              />
              {count} {label}
            </span>
          ),
      )}
      {newest && moved && (
        <Tooltip content={formatDateTime(newest.timestamp)}>
          <time dateTime={newest.timestamp} tabIndex={0}>
            {moved}
          </time>
        </Tooltip>
      )}
    </div>
  );
}

function PlanPurpose({ plan, state }: { plan: Plan; state: PlanViewState }) {
  const act = usePlanAction(state);
  const [draft, setDraft] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const saving = useRef(false);
  const { purpose } = plan;
  const purposeId = useId();
  function close() {
    setDraft(null);
    window.setTimeout(() => button.current?.focus());
  }
  async function commit() {
    if (draft === null || saving.current) return;
    if (draft.trim() === purpose.trim()) return close();
    saving.current = true;
    const saved = await act(
      () => plansClient.setPurpose(plan.id, draft.trim()),
      "save the purpose",
    );
    saving.current = false;
    if (saved) close();
  }
  if (draft !== null)
    return (
      <div className="plan-overview-purpose">
        <Input
          variant="inline"
          aria-label="Purpose"
          placeholder="e.g. Make the board feel stable and fast"
          autoFocus
          value={draft}
          readOnly={state.pending}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        />
      </div>
    );
  if (plan.archived && !purpose) return null;
  return (
    <div className="plan-overview-purpose">
      {plan.archived ? (
        <p
          id={purposeId}
          className="plan-overview-purpose-text"
          data-expanded={expanded}
        >
          {purpose}
        </p>
      ) : (
        <button
          ref={button}
          type="button"
          className="plan-overview-purpose-edit"
          aria-label={purpose ? `Edit purpose: ${purpose}` : "Add purpose"}
          onClick={() => setDraft(purpose)}
        >
          <span
            id={purposeId}
            className="plan-overview-purpose-text"
            data-expanded={expanded}
          >
            {purpose || "Add purpose"}
          </span>
          <Pencil aria-hidden="true" />
        </button>
      )}
      {purpose.length > 150 && (
        <Button
          variant="ghost"
          size="xs"
          aria-controls={purposeId}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

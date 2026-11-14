import { useCallback, useEffect, useState } from "react";
import {
  CircleCheck,
  Clock,
  History,
  LoaderCircle,
  UserRound,
  Workflow,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import {
  automationsClient,
  reported,
  type ReportRead,
  type Automation,
  type AutomationRun,
  type ListedRun,
} from "@/features/automations/client";
import {
  runsByDay,
  runsByNeed,
  runStatusText,
} from "@/features/automations/runs-model";
import { chatTime } from "@/features/chats/model";
import { useOnWorkspaceChange } from "@/lib/workspace-change";

/**
 * The mark beside a run: an icon in its status color. The word is always there
 * too. An answered Needs attention run is grey: it asks nothing any more.
 */
export function RunMark({
  run,
}: {
  run: Pick<AutomationRun, "status" | "answer">;
}) {
  switch (run.status) {
    case "queued":
      // Grey wherever it is drawn, not the color of the text around it.
      return <Clock size={14} className="text-muted-foreground" aria-hidden />;
    case "running":
      return (
        <LoaderCircle size={14} className="text-status-unread" aria-hidden />
      );
    case "completed":
      return (
        <CircleCheck size={14} className="text-status-ready" aria-hidden />
      );
    case "needs_attention":
      return <StatusDot tone={run.answer ? "neutral" : "attention"} />;
    case "taken_over":
      return <UserRound size={14} className="text-violet" aria-hidden />;
  }
}

/** One run as a row: the ticket it acts on, when, and where it stands. */
function RunRow({
  run,
  current = false,
  automationName,
  onOpen,
}: {
  run: AutomationRun;
  /** It is the run open beside the list. */
  current?: boolean;
  /** Named on the row where runs of several Automations are listed. */
  automationName?: string;
  onOpen: (runId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="chat-row"
        aria-current={current ? "true" : undefined}
        onClick={() => onOpen(run.id)}
        {...(run.needs_you && { "data-attention": "" })}
      >
        <span className="chat-row-mark">
          <RunMark run={run} />
        </span>
        <span className="chat-row-title">
          {run.ticket ? (
            <>
              <span className="auto-ref">{run.ticket.reference}</span>{" "}
              {run.ticket.title}
            </>
          ) : (
            "No ticket"
          )}
        </span>
        <time className="chat-row-time" dateTime={run.created_at}>
          {chatTime(run.created_at)}
        </time>
        <span className="chat-row-sub">
          <span>
            {run.needs_you ? (
              <strong>{runStatusText(run)}</strong>
            ) : (
              runStatusText(run)
            )}
          </span>
          {automationName === undefined ? (
            run.reason && <span title={run.reason}>{run.reason}</span>
          ) : (
            <span className="auto-row-start">
              <Workflow size={12} aria-hidden />
              {automationName.trim() || "New Automation"}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

const KEPT = "Runs are kept for 90 days, on this desktop only.";

/**
 * The runs of every Automation, under what they ask of the person: going now,
 * waiting on them, or over. `runs` arrive newest first.
 */
export function AllRunsList({
  runs,
  openId,
  onOpen,
}: {
  runs: ListedRun[];
  openId: string | null;
  onOpen: (runId: string) => void;
}) {
  if (runs.length === 0) return <p className="chat-list-empty">No runs yet.</p>;
  return (
    <>
      <div className="chat-rows">
        {runsByNeed(runs).map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3 className="auto-group">{group.label}</h3>
            <ul className="auto-runs" aria-label={`Runs, ${group.label}`}>
              {group.runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  current={run.id === openId}
                  automationName={run.automation_name}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="auto-list-foot">{KEPT}</p>
    </>
  );
}

/**
 * An Automation's runs on this desktop, newest first under the day they started.
 * It follows the Workspace, so a run that starts or ends shows up by itself.
 */
export function RunsList({
  automation,
  onOpen,
  onRead,
}: {
  automation: Automation;
  /** Opens a run's own view. */
  onOpen: (runId: string) => void;
  /** How reading the runs went. */
  onRead: ReportRead;
}) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const load = useCallback(
    () =>
      reported("runs", automationsClient.runs(automation.id), onRead, setRuns),
    [automation.id, onRead],
  );
  useEffect(() => void load(), [load]);
  useOnWorkspaceChange(() => void load());

  if (runs === null) return null;
  if (runs.length === 0) {
    const tag =
      automation.trigger?.kind === "tag_added" ? automation.trigger.tag : "";
    return (
      <div className="auto-empty">
        <EmptyState
          icon={<History aria-hidden />}
          title="No runs yet"
          description={
            automation.trigger?.kind === "by_hand"
              ? "It runs when you press Run now."
              : !automation.enabled
                ? "It runs once it is switched on for this desktop."
                : tag
                  ? `It runs the next time a ticket is tagged ${tag}.`
                  : automation.trigger?.kind === "schedule"
                    ? "It runs the next time its schedule comes round."
                    : "It runs the next time its trigger happens."
          }
        />
      </div>
    );
  }
  return (
    <>
      <div className="chat-rows">
        {runsByDay(runs).map((day) => (
          <section key={day.label} aria-label={day.label}>
            <h3 className="auto-group">{day.label}</h3>
            <ul className="auto-runs" aria-label={`Runs, ${day.label}`}>
              {day.runs.map((run) => (
                <RunRow key={run.id} run={run} onOpen={onOpen} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="auto-list-foot">{KEPT}</p>
    </>
  );
}

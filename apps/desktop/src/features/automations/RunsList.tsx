import { useCallback, useEffect, useState } from "react";
import {
  CircleCheck,
  Clock,
  History,
  LoaderCircle,
  UserRound,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import {
  automationsClient,
  type Automation,
  type AutomationRun,
} from "@/features/automations/client";
import {
  RUN_STATUS_LABELS,
  runsByDay,
} from "@/features/automations/runs-model";
import { chatTime } from "@/features/chats/model";
import { useOnWorkspaceChange } from "@/lib/workspace-change";

/** The mark beside a run: an icon in its status color. The word is always there too. */
function RunMark({ status }: { status: AutomationRun["status"] }) {
  switch (status) {
    case "queued":
      return <Clock size={14} aria-hidden />;
    case "running":
      return (
        <LoaderCircle size={14} className="text-status-unread" aria-hidden />
      );
    case "completed":
      return (
        <CircleCheck size={14} className="text-status-ready" aria-hidden />
      );
    case "needs_attention":
      return <StatusDot tone="attention" />;
    case "taken_over":
      return <UserRound size={14} aria-hidden />;
  }
}

/**
 * An Automation's runs on this desktop, newest first under the day they started.
 * It follows the Workspace, so a run that starts or ends shows up by itself.
 */
export function RunsList({
  automation,
  onFail,
}: {
  automation: Automation;
  onFail: (reason: unknown) => void;
}) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const load = useCallback(
    () => automationsClient.runs(automation.id).then(setRuns, onFail),
    [automation.id, onFail],
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
            !automation.enabled
              ? "It runs once it is switched on for this desktop."
              : tag
                ? `It runs the next time a ticket is tagged ${tag}.`
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
                <li
                  key={run.id}
                  className="chat-row"
                  data-static
                  {...(run.status === "needs_attention" && {
                    "data-attention": "",
                  })}
                >
                  <span className="chat-row-mark">
                    <RunMark status={run.status} />
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
                      {run.status === "needs_attention" ? (
                        <strong>{RUN_STATUS_LABELS[run.status]}</strong>
                      ) : (
                        RUN_STATUS_LABELS[run.status]
                      )}
                    </span>
                    {run.reason && <span title={run.reason}>{run.reason}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="auto-list-foot">
        Runs are kept for 90 days, on this desktop only.
      </p>
    </>
  );
}

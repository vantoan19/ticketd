import { useContext, useState } from "react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Button } from "@/components/ui/button";
import {
  automationsClient,
  type TicketRun,
} from "@/features/automations/client";
import { RunNavigation } from "@/features/automations/navigation";
import { RunMark } from "@/features/automations/RunsList";
import { runStatusText } from "@/features/automations/runs-model";
import { chatTime } from "@/features/chats/model";
import { useChatFeature } from "@/features/chats/use-chats";
import type { useTicketRuns } from "@/features/automations/use-ticket-runs";
import { RailSection } from "@/features/tickets/RailSection";
import "@/features/automations/automations.css";

const nameOf = (run: TicketRun) =>
  run.automation_name.trim() || "An Automation";

/** Notices shown before the rest fold into one line. */
const SHOWN = 2;

/**
 * A notice at the top of a ticket for each of its runs that needs attention,
 * newest first, each with when it started. It stays until the person runs the
 * run again, takes it over or dismisses it; opening the run leaves it. While
 * Chat is off the run cannot be opened or run again, so it offers Dismiss only.
 */
export function RunNotices({
  runs,
  error,
  reload,
  chatOn,
}: ReturnType<typeof useTicketRuns>) {
  const openRun = useContext(RunNavigation);
  const [failure, setFailure] = useState<{
    description: FailureDescription;
    retry?: () => void;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const waiting = runs.filter((run) => run.needs_you);
  const folded = all ? 0 : Math.max(0, waiting.length - SHOWN);
  const act = (
    action: () => Promise<unknown>,
    verb: string,
    retryable = true,
  ) => {
    setBusy(true);
    void action()
      .then(
        () => setFailure(null),
        (reason: unknown) =>
          setFailure({
            description: describeFailure(reason, verb),
            ...(retryable && { retry: () => act(action, verb) }),
          }),
      )
      .finally(() => {
        setBusy(false);
        reload();
      });
  };
  return (
    <>
      {waiting.slice(0, waiting.length - folded).map((run) => (
        <Alert
          key={run.id}
          tone="attention"
          role="region"
          aria-label={`${nameOf(run)} needs attention`}
          className="mb-6"
        >
          <AlertTitle>
            {nameOf(run)} needs attention · {chatTime(run.created_at)}
          </AlertTitle>
          {(run.reason || run.automation_deleted || !chatOn) && (
            <AlertDescription>
              {[
                run.reason,
                run.automation_deleted && "Its Automation was deleted.",
                !chatOn && "Turn Chat on to open this run.",
              ]
                .filter(Boolean)
                .join(" ")}
            </AlertDescription>
          )}
          <AlertActions>
            {chatOn && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openRun?.(run.id)}
              >
                Open run
              </Button>
            )}
            {chatOn && !run.automation_deleted && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(
                    () => automationsClient.runAgain(run.id),
                    "run this Automation again",
                    false,
                  )
                }
              >
                Run again
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                act(
                  () => automationsClient.dismissRun(run.id),
                  "dismiss this run",
                )
              }
            >
              Dismiss
            </Button>
          </AlertActions>
        </Alert>
      ))}
      {folded > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mb-6"
          onClick={() => setAll(true)}
        >
          {folded === 1
            ? "Show 1 more run that needs attention"
            : `Show ${folded} more runs that need attention`}
        </Button>
      )}
      {failure && (
        <FailureAlert
          failure={failure.description}
          {...(failure.retry && { onRetry: failure.retry })}
          className="mb-6"
        />
      )}
      {error && (
        <p role="alert" className="mb-6">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The "Runs" section of a ticket's side panel. A ticket without runs has none,
 * and neither does any ticket while Chat is off, when no run can be opened.
 */
export function TicketRunsSection({ runs }: { runs: TicketRun[] }) {
  const openRun = useContext(RunNavigation);
  const chatOn = useChatFeature().enabled;
  if (runs.length === 0 || !chatOn) return null;
  return (
    <RailSection label="Runs">
      <ul className="ticket-runs">
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              className="ticket-run"
              onClick={() => openRun?.(run.id)}
            >
              <span className="ticket-run-name">{nameOf(run)}</span>
              <span className="ticket-run-state">
                <RunMark run={run} />
                {runStatusText(run)} · {chatTime(run.created_at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </RailSection>
  );
}

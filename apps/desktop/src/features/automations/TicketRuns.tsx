import { useContext, useState } from "react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  automationsClient,
  type TicketRun,
} from "@/features/automations/client";
import { RunNavigation } from "@/features/automations/navigation";
import { RunMark } from "@/features/automations/RunsList";
import { RUN_STATUS_LABELS } from "@/features/automations/runs-model";
import { chatTime } from "@/features/chats/model";
import type { useTicketRuns } from "@/features/automations/use-ticket-runs";
import { RailSection } from "@/features/tickets/RailSection";
import "@/features/automations/automations.css";

const nameOf = (run: TicketRun) =>
  run.automation_name.trim() || "An Automation";

/**
 * A notice at the top of a ticket for each of its runs that needs attention. It
 * stays until the person runs the run again, takes it over or dismisses it;
 * opening the run leaves it.
 */
export function RunNotices({
  runs,
  error,
  reload,
}: ReturnType<typeof useTicketRuns>) {
  const openRun = useContext(RunNavigation);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const act = (action: Promise<unknown>) => {
    setBusy(true);
    void action
      .then(
        () => setFailure(""),
        (reason: unknown) => setFailure(String(reason)),
      )
      .finally(() => {
        setBusy(false);
        reload();
      });
  };
  return (
    <>
      {runs
        .filter((run) => run.needs_you)
        .map((run) => (
          <Alert
            key={run.id}
            tone="attention"
            role="region"
            aria-label={`${nameOf(run)} needs attention`}
            className="mb-6"
          >
            <AlertTitle>{nameOf(run)} needs attention</AlertTitle>
            {run.reason && <AlertDescription>{run.reason}</AlertDescription>}
            <AlertActions>
              <Button
                variant="outline"
                size="sm"
                onClick={() => openRun?.(run.id)}
              >
                Open run
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => act(automationsClient.runAgain(run.id))}
              >
                Run again
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => act(automationsClient.dismissRun(run.id))}
              >
                Dismiss
              </Button>
            </AlertActions>
          </Alert>
        ))}
      {(failure || error) && (
        <p role="alert" className="mb-6">
          {failure || error}
        </p>
      )}
    </>
  );
}

/** The "Runs" section of a ticket's side panel. A ticket without runs has none. */
export function TicketRunsSection({ runs }: { runs: TicketRun[] }) {
  const openRun = useContext(RunNavigation);
  if (runs.length === 0) return null;
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
                <RunMark status={run.status} />
                {RUN_STATUS_LABELS[run.status]} · {chatTime(run.created_at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </RailSection>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { plansClient, type View } from "@/lib/api/plans";
import { useWorkspaceChange } from "@/lib/workspace-change";
import {
  useTicketChanged,
  type ReturnedTickets,
} from "@/features/tickets/open-ticket";
import {
  useStatusLine,
  type StatusLineMessage,
} from "@/components/ui/use-status-line";

/**
 * Loads one Plan's counts and members and runs its actions. The view reloads
 * whenever `revision` changes, so changes made with the CLI show up too. Each
 * change is reported as a write (`useTicketChanged`), so the Ticket list and
 * the open Ticket show it at once.
 */
export function usePlanView(planId: string, revision: number) {
  const changed = useTicketChanged();
  const [loaded, setLoaded] = useState<{
    id: string;
    view: View | null;
    error: FailureDescription | null;
  } | null>(null);
  const changeVersion = useWorkspaceChange();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<FailureDescription | null>(
    null,
  );
  // The change that failed, so Retry repeats exactly it.
  const lastChange = useRef<{
    change: () => Promise<ReturnedTickets | void>;
    action: string;
  } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [adding, setAdding] = useState(false);
  const [previousId, setPreviousId] = useState(planId);
  if (previousId !== planId) {
    setPreviousId(planId);
    setActionError(null);
    setAdding(false);
  }
  useEffect(() => {
    if (!planId) return;
    let active = true;
    plansClient.show(planId).then(
      (view) => {
        if (active) setLoaded({ id: planId, view, error: null });
      },
      (reason: unknown) => {
        if (active)
          setLoaded({
            id: planId,
            view: null,
            error: describeFailure(reason, "load this Plan"),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [planId, revision, changeVersion, loadAttempt]);
  const current = loaded?.id === planId ? loaded : null;
  /**
   * Runs a change, then reports the write, whose report reloads this Plan
   * through the shared version. A change may return the Tickets it changed. A failure rejects, so the caller
   * reports it where it belongs (`usePlanAction`).
   */
  const apply = useCallback(
    async (change: () => Promise<ReturnedTickets | void>) => {
      setPending(true);
      try {
        const returned = await change();
        await changed(returned ?? null);
      } finally {
        setPending(false);
      }
    },
    [changed],
  );
  /**
   * Runs a change and reports whether it worked, keeping a failure as
   * `actionError` for a dialog to show. `action` names the change for that
   * failure, such as "add tickets to Docs launch".
   */
  const run = useCallback(
    async (
      change: () => Promise<ReturnedTickets | void>,
      action = "change this Plan",
    ) => {
      lastChange.current = { change, action };
      setActionError(null);
      try {
        await apply(change);
        return true;
      } catch (reason) {
        setActionError(describeFailure(reason, action));
        return false;
      }
    },
    [apply],
  );
  /** Repeats the change that failed. */
  const retry = useCallback(() => {
    const last = lastChange.current;
    return last ? run(last.change, last.action) : Promise.resolve(false);
  }, [run]);
  const reload = useCallback(() => setLoadAttempt((value) => value + 1), []);
  return {
    view: current?.view ?? null,
    loadError: current?.error ?? null,
    reload,
    pending,
    actionError,
    retry,
    adding,
    setAdding,
    run,
    apply,
  };
}

export type PlanViewState = ReturnType<typeof usePlanView>;

/**
 * Runs a Plan change from outside a dialog and reports it on the status line
 * of the pane it is used in (P6): `outcome` when it worked ("Archived Docs
 * launch · Undo"), else the failure in plain words with Retry when retrying
 * can succeed. Resolves to whether the change was made.
 */
export function usePlanAction({ apply }: Pick<PlanViewState, "apply">) {
  const statusLine = useStatusLine();
  return useCallback(
    async function act(
      change: () => Promise<ReturnedTickets | void>,
      action: string,
      outcome?: StatusLineMessage,
    ): Promise<boolean> {
      try {
        await apply(change);
        if (outcome) statusLine.show(outcome);
        return true;
      } catch (reason) {
        const failure = describeFailure(reason, action);
        statusLine.show({
          tone: "error",
          message: `${failure.title}. ${failure.sentence}`,
          details: failure.details,
          ...(failure.action === "retry" && {
            action: {
              label: "Retry",
              run: () => act(change, action, outcome),
            },
          }),
        });
        return false;
      }
    },
    [apply, statusLine],
  );
}

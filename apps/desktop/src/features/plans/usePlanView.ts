import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { plansClient, type View } from "@/lib/api/plans";
import { useWorkspaceChange } from "@/lib/workspace-change";

/**
 * Loads one Plan's counts and members and runs its actions. The view reloads
 * whenever `revision` changes, so changes made with the CLI show up too.
 */
export function usePlanView(
  planId: string,
  revision: number,
  refresh: () => Promise<void>,
) {
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
    change: () => Promise<unknown>;
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
   * Runs a change, refreshes the workspace, and reports whether it worked.
   * `action` names the change for a failure, such as "archive Docs launch".
   */
  const run = useCallback(
    async (change: () => Promise<unknown>, action = "change this Plan") => {
      lastChange.current = { change, action };
      setPending(true);
      setActionError(null);
      try {
        await change();
        await refresh();
        // Show this change now rather than at the next workspace poll.
        await plansClient.show(planId).then(
          (view) => setLoaded({ id: planId, view, error: null }),
          () => {},
        );
        return true;
      } catch (reason) {
        setActionError(describeFailure(reason, action));
        return false;
      } finally {
        setPending(false);
      }
    },
    [refresh, planId],
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
  };
}

export type PlanViewState = ReturnType<typeof usePlanView>;

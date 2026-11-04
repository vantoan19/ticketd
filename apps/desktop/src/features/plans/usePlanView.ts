import { useCallback, useEffect, useState } from "react";
import { plansClient, type View } from "@/lib/api/plans";

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
    error: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [adding, setAdding] = useState(false);
  const [previousId, setPreviousId] = useState(planId);
  if (previousId !== planId) {
    setPreviousId(planId);
    setActionError("");
    setAdding(false);
  }
  useEffect(() => {
    if (!planId) return;
    let active = true;
    plansClient.show(planId).then(
      (view) => {
        if (active) setLoaded({ id: planId, view, error: "" });
      },
      (reason: unknown) => {
        if (active)
          setLoaded({ id: planId, view: null, error: String(reason) });
      },
    );
    return () => {
      active = false;
    };
  }, [planId, revision]);
  const current = loaded?.id === planId ? loaded : null;
  /** Runs a change, refreshes the workspace, and reports whether it worked. */
  const run = useCallback(
    async (change: () => Promise<unknown>) => {
      setPending(true);
      setActionError("");
      try {
        await change();
        await refresh();
        return true;
      } catch (reason) {
        setActionError(String(reason));
        return false;
      } finally {
        setPending(false);
      }
    },
    [refresh],
  );
  return {
    view: current?.view ?? null,
    loadError: current?.error ?? "",
    pending,
    actionError,
    adding,
    setAdding,
    run,
  };
}

export type PlanViewState = ReturnType<typeof usePlanView>;

import { useCallback, useEffect, useState } from "react";
import { effortsClient, type View } from "@/lib/api/efforts";

/**
 * Loads one Effort's counts and members and runs its actions. The view reloads
 * whenever `revision` changes, so changes made with the CLI show up too.
 */
export function useEffortView(
  effortId: string,
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
  const [previousId, setPreviousId] = useState(effortId);
  if (previousId !== effortId) {
    setPreviousId(effortId);
    setActionError("");
  }
  useEffect(() => {
    if (!effortId) return;
    let active = true;
    effortsClient.show(effortId).then(
      (view) => {
        if (active) setLoaded({ id: effortId, view, error: "" });
      },
      (reason: unknown) => {
        if (active)
          setLoaded({ id: effortId, view: null, error: String(reason) });
      },
    );
    return () => {
      active = false;
    };
  }, [effortId, revision]);
  const current = loaded?.id === effortId ? loaded : null;
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
    run,
  };
}

export type EffortViewState = ReturnType<typeof useEffortView>;

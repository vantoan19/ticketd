import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { syncApi, type SyncStatus } from "@/lib/sync-api";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { SyncStatusContext, type SyncNavigation } from "./sync-status";

const POLL_MS = 2000;

/**
 * Reads the sync status for every place that shows it. A Workspace that does not
 * sync costs nothing beyond the workspace change poll: its status is read on
 * launch and when workspace data changes. Once sync is set up the status is also
 * polled at the same cadence, because upload progress, going offline and an
 * expired sign-in are not workspace data and do not move the change token.
 */
export function SyncStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  // A read that started before a newer status arrived must not put the old one back.
  const generation = useRef(0);
  const navigation = useRef<SyncNavigation | null>(null);
  const actions = useMemo(() => {
    const apply = (next: SyncStatus) => {
      generation.current += 1;
      setStatus(next);
    };
    return {
      apply,
      refresh: async () => {
        const next = await syncApi.status();
        apply(next);
        return next;
      },
      openSettings: () => navigation.current?.openSettings(),
      openReview: () => navigation.current?.openReview(),
      setNavigation: (next: SyncNavigation) => {
        navigation.current = next;
      },
    };
  }, []);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const read = useMemo(
    () => () => {
      const started = generation.current;
      void syncApi
        .status()
        .then((next) => {
          if (mounted.current && started === generation.current)
            setStatus(next);
        })
        .catch(() => {
          // Keep what is shown; the next read tries again.
        });
    },
    [],
  );
  const version = useWorkspaceChange();
  useEffect(read, [read, version]);
  const syncing = status !== null && status.connection !== "not_connected";
  useEffect(() => {
    if (!syncing) return;
    const timer = window.setInterval(read, POLL_MS);
    return () => window.clearInterval(timer);
  }, [read, syncing]);
  const value = useMemo(() => ({ status, ...actions }), [status, actions]);
  return <SyncStatusContext value={value}>{children}</SyncStatusContext>;
}

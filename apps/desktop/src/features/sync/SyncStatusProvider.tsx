import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onSyncStatus, syncApi, type SyncStatus } from "@/lib/sync-api";
import {
  SyncNavigationContext,
  SyncStatusContext,
  type SyncNavigation,
} from "./sync-status";

/** The status the bridge sent is plain JSON, so equal text is an equal status. */
const unchanged = (previous: SyncStatus | null, next: SyncStatus) =>
  previous !== null && JSON.stringify(previous) === JSON.stringify(next);

/**
 * Holds the sync status for every place that shows it. It is read once on
 * launch; after that the desktop sends it each time it changes (a local change,
 * a run, upload progress, going offline, an expired sign-in), so nothing here
 * polls.
 */
export function SyncStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  // A read that started before a newer status arrived must not put the old one back.
  const generation = useRef(0);
  const navigation = useRef<SyncNavigation | null>(null);
  // The same status again keeps the old object, so nothing re-renders.
  const show = useMemo(
    () => (next: SyncStatus) =>
      setStatus((previous) => (unchanged(previous, next) ? previous : next)),
    [],
  );
  const actions = useMemo(() => {
    const apply = (next: SyncStatus) => {
      generation.current += 1;
      show(next);
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
    };
  }, [show]);
  // Its own context: the shell registers navigation without following the status.
  const setNavigation = useMemo(
    () => (next: SyncNavigation) => {
      navigation.current = next;
    },
    [],
  );
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    // Listening first, so a change sent during the first read is not missed.
    void onSyncStatus((next) => {
      if (active) actions.apply(next);
    })
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch(() => {})
      .finally(() => {
        const started = generation.current;
        void syncApi
          .status()
          .then((next) => {
            if (active && started === generation.current) show(next);
          })
          .catch(() => {
            // Nothing is shown until the desktop sends a status.
          });
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [actions, show]);
  const value = useMemo(() => ({ status, ...actions }), [status, actions]);
  return (
    <SyncNavigationContext value={setNavigation}>
      <SyncStatusContext value={value}>{children}</SyncStatusContext>
    </SyncNavigationContext>
  );
}

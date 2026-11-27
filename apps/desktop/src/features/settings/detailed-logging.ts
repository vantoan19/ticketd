import { useSyncExternalStore } from "react";
import { diagnosticsClient } from "@/lib/api/diagnostics";

/**
 * When detailed logging started for the open report, or null: the one fact the sidebar's
 * status line and Settings › Diagnostics share. Diagnostics sets it when a report starts,
 * ends or is read; the sidebar reads it once when it opens.
 */
let startedAt: string | null = null;
/** Counts every change, so a read that was started before one can tell it is stale. */
let revision = 0;
const listeners = new Set<() => void>();

export function setDetailedLogging(next: string | null) {
  if (next === startedAt) return;
  startedAt = next;
  revision += 1;
  for (const listener of listeners) listener();
}

/** Reads the state from the app. A read that fails leaves what is shown as it was. */
export async function refreshDetailedLogging() {
  const asked = revision;
  try {
    const { report_started_at } = await diagnosticsClient.logLevel();
    // A report that started or ended while this read was out is newer than it.
    if (revision === asked) setDetailedLogging(report_started_at);
  } catch {
    // The status line is only a reminder; Diagnostics reports a failed read itself.
  }
}

/** When the open report's detailed logging started; null while there is none. */
export function useDetailedLogging(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => startedAt,
  );
}

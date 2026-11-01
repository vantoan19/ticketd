import { createContext, useContext } from "react";
import type { SourceStatus } from "@/lib/api/sources";

/**
 * How the configured sources are doing right now, for every place that shows it:
 * the sidebar footer, the list header and the detail rail. The workspace owns the
 * data; this only carries it down.
 */
export type SourceActivity = {
  /** A refresh is running (startup, periodic or explicit). */
  refreshing: boolean;
  /** Persisted status of each source with a saved configuration or a past run. */
  sources: SourceStatus[];
  /** Refreshes every source now, as the Retry and Refresh actions do. */
  refreshAll: () => Promise<void>;
};

export const SourceActivityContext = createContext<SourceActivity>({
  refreshing: false,
  sources: [],
  refreshAll: async () => {},
});

export function useSourceActivity(): SourceActivity {
  return useContext(SourceActivityContext);
}

export type SourceLineState =
  "refreshing" | "unavailable" | "delayed" | "synced" | "waiting";

/** What one source's status line says. A rate limit is delayed, never unavailable. */
export function sourceLine(
  status: SourceStatus,
  refreshing: boolean,
): SourceLineState {
  if (refreshing) return "refreshing";
  const code = status.error?.code;
  if (code === "rate_limited") return "delayed";
  if (code || status.unavailable_tickets > 0) return "unavailable";
  return status.last_refreshed_at ? "synced" : "waiting";
}

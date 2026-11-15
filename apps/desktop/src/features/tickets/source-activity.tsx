import { createContext, useContext } from "react";
import type {
  SourceEntry,
  SourceHealthState,
  SourceStatus,
} from "@/lib/api/sources";

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
  /**
   * The connectors this build offers and what is saved for each, read once by the
   * workspace. `null` where no workspace provides it (a view rendered alone).
   */
  entries: SourceEntry[] | null;
  /** How often sources refresh by themselves, in seconds; `null` when unknown. */
  intervalSecs: number | null;
  /** Opens the Sources settings, where a source's connection and rules live. */
  openSettings: () => void;
  /** Opens one source's own settings page, such as GitHub's. */
  openSourceSettings?: (provider: string) => void;
  /** Refreshes every source now, as the Retry and Refresh actions do. */
  refreshAll: () => Promise<void>;
};

export const SourceActivityContext = createContext<SourceActivity>({
  refreshing: false,
  sources: [],
  entries: null,
  intervalSecs: null,
  openSettings: () => {},
  refreshAll: async () => {},
});

export function useSourceActivity(): SourceActivity {
  return useContext(SourceActivityContext);
}

export type SourceLineState = "refreshing" | SourceHealthState;

/** What one source's status line says. The core decides the health; this only picks wording. */
export function sourceLine(
  status: SourceStatus,
  refreshing: boolean,
): SourceLineState {
  return refreshing ? "refreshing" : status.health;
}

import { useMemo } from "react";
import { useDetailedLogging } from "@/features/settings/detailed-logging";
import { deriveNeeds, type Need } from "@/features/settings/settings-needs";
import { useSettingsState } from "@/features/settings/use-settings-state";
import type { IndicatorSection } from "@/features/settings/use-settings-state";
import { useSyncStatus } from "@/features/sync/sync-status";
import { useSourceActivity } from "@/features/tickets/source-activity";
import { useUpdates } from "@/features/updates/update-state";

/**
 * Every page that needs the person, from what the app already reads: the sync
 * status, the sources' health, the command line and skills readings, the
 * update and the open report. Nothing here reads anything itself, so it adds no
 * timer or bridge call.
 */
export function useNeedsFrom(
  needsSetup: Partial<Record<IndicatorSection, boolean>>,
): Need[] {
  const { status: sync } = useSyncStatus();
  const { entries, sources, github } = useSourceActivity();
  const update = useUpdates()?.snapshot ?? null;
  const loggingSince = useDetailedLogging();
  return useMemo(
    () =>
      deriveNeeds({
        sync,
        sources: {
          entries: entries ?? [],
          health: sources,
          github: github ?? null,
        },
        needsSetup,
        update,
        loggingSince,
      }),
    [sync, entries, sources, github, needsSetup, update, loggingSince],
  );
}

/** The needs, for the places below the Settings state: the nav, the pages and the sidebar. */
export function useNeeds(): Need[] {
  return useNeedsFrom(useSettingsState().needsSetup);
}

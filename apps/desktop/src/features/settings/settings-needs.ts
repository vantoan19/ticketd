import type { SourceEntry, SourceStatus } from "@/lib/api/sources";
import type { SyncStatus } from "@/lib/sync-api";
import type { UpdateSnapshot } from "@/features/updates/client";
import { connectionState } from "@/features/sync/sync-recovery";
import { sourceRows } from "@/features/settings/sources/source-rows";
import type { SettingsSectionId } from "@/features/settings/settings-sections";

/**
 * What needs the person, one entry per page. The Settings nav marks the page,
 * the app sidebar's status line says it where the person works, and Settings
 * opens on the first page that needs them: all three read this one list.
 */
export type NeedKind =
  | "sync"
  | "sources"
  | "command-line"
  | "agent-skills"
  | "agents"
  | "update"
  | "logging";

export interface Need {
  kind: NeedKind;
  /** The page that carries the mark and has the fix. */
  page: SettingsSectionId;
  /** The mark's spoken label; the page says the same words. */
  mark: string;
  /**
   * True for a problem: Settings opens on its page. A reminder (an update is
   * ready, detailed logging is on) is marked and said in the status line, but
   * never takes Settings from the page the person last used.
   */
  opens: boolean;
}

/** What the needs are read from; each is "nothing to say" while unknown. */
export interface NeedInputs {
  sync: SyncStatus | null;
  sources: { entries: readonly SourceEntry[]; health: readonly SourceStatus[] };
  /** The Settings state's readings: true when the page would ask for a step. */
  needsSetup: Partial<
    Record<"command-line" | "agent-skills" | "agents", boolean>
  >;
  update: UpdateSnapshot | null;
  /** When detailed logging started for the open report, or null. */
  loggingSince: string | null;
}

/** Sync stops for the person only when something has to be done. Offline and slowed down mend themselves. */
export function syncNeedsYou(status: SyncStatus | null): status is SyncStatus {
  return (
    status !== null &&
    status.connection === "connected" &&
    status.recovery !== null &&
    status.recovery !== "offline" &&
    status.recovery !== "rate_limited"
  );
}

/** The update the person has not acted on, once the notice that announced it was dismissed. */
export function updateNeedsYou(
  update: UpdateSnapshot | null,
): "ready" | "available" | "failed" | null {
  if (!update?.dismissed) return null;
  switch (update.status) {
    case "ready":
      return "ready";
    case "manual_install":
      return "available";
    case "download_failed":
      return "failed";
    default:
      return null;
  }
}

/** The connections that need the person, as the Ticket sources list says it. */
export function sourcesNeedYou(
  entries: readonly SourceEntry[],
  health: readonly SourceStatus[],
) {
  return sourceRows(entries, health).filter(
    (row) => row.status === "Needs sign-in" || row.status === "Unavailable",
  );
}

/** Every page that needs the person, in the order the nav lists them. */
export function deriveNeeds(input: NeedInputs): Need[] {
  const needs: Need[] = [];
  if (syncNeedsYou(input.sync))
    needs.push({
      kind: "sync",
      page: "workspace-sync",
      mark: connectionState(input.sync).label,
      opens: true,
    });
  if (input.needsSetup["command-line"])
    needs.push({
      kind: "command-line",
      page: "command-line",
      mark: "Needs setup",
      opens: true,
    });
  if (input.needsSetup["agent-skills"])
    needs.push({
      kind: "agent-skills",
      page: "agent-skills",
      mark: "Needs setup",
      opens: true,
    });
  if (input.needsSetup.agents)
    needs.push({
      kind: "agents",
      page: "agents",
      mark: "Needs setup",
      opens: true,
    });
  const sources = sourcesNeedYou(input.sources.entries, input.sources.health);
  if (sources.length > 0)
    needs.push({
      kind: "sources",
      page: "ticket-sources",
      mark: sources.some((row) => row.status === "Needs sign-in")
        ? "Needs sign-in"
        : "Unavailable",
      opens: true,
    });
  if (input.loggingSince)
    needs.push({
      kind: "logging",
      page: "diagnostics",
      mark: "Detailed logging is on",
      opens: false,
    });
  const update = updateNeedsYou(input.update);
  if (update)
    needs.push({
      kind: "update",
      page: "about",
      mark:
        update === "ready"
          ? "Update ready"
          : update === "available"
            ? "Update available"
            : "Update failed",
      opens: false,
    });
  return needs;
}

/** The page Settings opens on for these needs: the first problem, in nav order. */
export function pageNeedingYou(
  needs: readonly Need[],
): SettingsSectionId | null {
  return needs.find((need) => need.opens)?.page ?? null;
}

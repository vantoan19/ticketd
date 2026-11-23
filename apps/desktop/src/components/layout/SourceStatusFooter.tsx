import { StatusDot } from "@/components/ui/status-dot";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  sourceLine,
  useSourceActivity,
} from "@/features/tickets/source-activity";
import { ago } from "@/features/tickets/ticket-source";
import { providerName } from "@/lib/api/sources";
import { useSources } from "@/features/settings/sources/use-sources";
import { useNow } from "@/lib/use-now";
import { SyncStatusLine } from "@/features/sync/SyncStatusLine";
import { useSyncStatus } from "@/features/sync/sync-status";
import { usePreferences } from "@/lib/preferences";
import { useIsMobile } from "@/hooks/use-mobile";

export function SourceStatusFooter() {
  const now = useNow();
  const { entries } = useSources();
  const { refreshing, sources, refreshAll, openSettings, intervalSecs } =
    useSourceActivity();
  // Only the folded rail hides the two lines, so only it repeats them.
  const { sidebarCollapsed } = usePreferences();
  const isMobile = useIsMobile();
  const folded = sidebarCollapsed && !isMobile;
  const synced = useSyncStatus().status?.connection === "connected";
  if (sources.length === 0 && !synced) return null;
  return (
    <div
      className="sidebar-sources"
      role="group"
      aria-label={
        !synced
          ? "Ticket sources"
          : sources.length > 0
            ? "Sync and ticket sources"
            : "Sync"
      }
    >
      {synced && <SyncStatusLine />}
      {sources.map((status) => {
        const name = providerName(status.provider, entries);
        const state = sourceLine(status, refreshing);
        const synced = status.last_refreshed_at
          ? ago(status.last_refreshed_at, now)
          : null;
        const warning =
          state === "unavailable" || state === "partial" || state === "delayed";
        const count = status.unavailable_tickets;
        const label =
          state === "refreshing"
            ? `Refreshing ${name}…`
            : state === "synced"
              ? `${name} synced`
              : count > 0
                ? `${count} source ${count === 1 ? "issue" : "issues"}`
                : state === "unavailable"
                  ? `${name} unavailable`
                  : state === "delayed"
                    ? `${name} refresh delayed`
                    : state === "partial"
                      ? `${name} partly refreshed`
                      : `${name} not synced yet`;
        // The line under the label; the collapsed sidebar hides it, so the
        // tooltip repeats it.
        const detail =
          state === "refreshing"
            ? !status.tracked_tickets
              ? `Checking ${name} tickets`
              : `Checking ${status.tracked_tickets} ${name} ${status.tracked_tickets === 1 ? "ticket" : "tickets"}`
            : warning
              ? synced
                ? `${name} last synced ${synced}`
                : "Showing saved content"
              : `${synced ?? "Not synced yet"}${intervalSecs ? ` · every ${Math.round(intervalSecs / 60)} min` : ""}`;
        const detailId = `sidebar-source-${status.provider}`;
        return (
          <div className="sidebar-source" key={status.provider}>
            <Tooltip content={folded ? `${label} · ${detail}` : null}>
              <button
                type="button"
                className="sidebar-source-line"
                onClick={() => openSettings(status.provider)}
                aria-describedby={detailId}
              >
                <span className="sidebar-source-label">
                  {state !== "refreshing" && (
                    <StatusDot
                      tone={
                        warning
                          ? "attention"
                          : state === "synced"
                            ? "positive"
                            : "neutral"
                      }
                      size={10}
                    />
                  )}
                  {label}
                </span>
                <small id={detailId}>{detail}</small>
              </button>
            </Tooltip>
            {warning && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refreshAll()}
              >
                Retry
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

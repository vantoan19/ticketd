import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import {
  sourceLine,
  useSourceActivity,
} from "@/features/tickets/source-activity";
import { ago, providerName } from "@/features/tickets/ticket-source";

/**
 * Each configured source's state at the foot of the sidebar: Refreshing GitHub…
 * (words only), synced time (green dot), or an unavailable or delayed warning
 * (orange dot) with Retry. Nothing renders until a source has a configuration.
 */
export function SourceStatusFooter() {
  const { refreshing, sources, refreshAll, openSettings } = useSourceActivity();
  if (sources.length === 0) return null;
  return (
    <div className="sidebar-sources" role="group" aria-label="Ticket sources">
      {sources.map((status) => {
        const name = providerName(status.provider);
        const state = sourceLine(status, refreshing);
        const synced = status.last_refreshed_at
          ? ago(status.last_refreshed_at)
          : null;
        // The status line opens the source's settings, where its connection and
        // rules live.
        const line = (children: ReactNode) => (
          <button
            type="button"
            className="sidebar-source-line"
            title={`Open ${name} settings`}
            onClick={openSettings}
          >
            {children}
          </button>
        );
        return (
          <div key={status.provider} className="sidebar-source">
            {state === "refreshing" && line(`Refreshing ${name}…`)}
            {state === "synced" &&
              line(
                <>
                  <StatusDot tone="positive" size={6} /> {name} synced {synced}
                </>,
              )}
            {state === "waiting" && line(`${name} not synced yet`)}
            {(state === "unavailable" ||
              state === "delayed" ||
              state === "partial") && (
              <>
                {line(
                  <>
                    <StatusDot tone="attention" size={6} />{" "}
                    {state === "unavailable"
                      ? `${name} unavailable`
                      : state === "delayed"
                        ? `${name} refresh delayed`
                        : `${name} partly refreshed`}
                  </>,
                )}
                <small>
                  {status.error?.message ??
                    status.partial_message ??
                    "Some tickets could not be refreshed."}{" "}
                  {synced
                    ? `Showing content synced ${synced}.`
                    : "Showing saved content."}
                </small>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void refreshAll()}
                >
                  Retry
                </Button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

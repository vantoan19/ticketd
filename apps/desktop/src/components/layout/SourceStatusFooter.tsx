import { StatusDot } from "@/components/ui/status-dot";
import { Button } from "@/components/ui/button";
import {
  sourceLine,
  useSourceActivity,
} from "@/features/tickets/source-activity";
import { ago, providerName } from "@/features/tickets/ticket-source";
import { useNow } from "@/lib/use-now";

export function SourceStatusFooter() {
  const now = useNow();
  const { refreshing, sources, refreshAll, openSettings, intervalSecs } =
    useSourceActivity();
  if (sources.length === 0) return null;
  return (
    <div className="sidebar-sources" role="group" aria-label="Ticket sources">
      {sources.map((status) => {
        const name = providerName(status.provider);
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
        return (
          <div className="sidebar-source" key={status.provider}>
            <button
              type="button"
              className="sidebar-source-line"
              onClick={openSettings}
              title={`Open ${name} settings`}
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
              <small>
                {state === "refreshing"
                  ? `Checking ${name} tickets`
                  : warning
                    ? synced
                      ? `${name} last synced ${synced}`
                      : "Showing saved content"
                    : `${synced ?? "Not synced yet"}${intervalSecs ? ` · every ${Math.round(intervalSecs / 60)} min` : ""}`}
              </small>
            </button>
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

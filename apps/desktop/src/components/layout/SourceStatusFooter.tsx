import { useContext, useEffect } from "react";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
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
import {
  refreshDetailedLogging,
  useDetailedLogging,
} from "@/features/settings/detailed-logging";
import { SettingsNavigation } from "@/lib/settings-navigation";
import { relativeDateTime } from "@/lib/format";
import { useNeeds } from "@/features/settings/use-needs";
import {
  sourcesNeedYou,
  updateNeedsYou,
} from "@/features/settings/settings-needs";
import { SIGNED_OUT } from "@/features/settings/sources/source-rows";
import { useUpdates } from "@/features/updates/update-state";

/**
 * One problem on the status line: a line that opens its page, and its one
 * action. The collapsed sidebar hides the second line, so the tooltip repeats it.
 */
function NeedLine({
  id,
  tone,
  label,
  detail,
  action,
  actionName,
  folded,
  onOpen,
  onAct = onOpen,
}: {
  id: string;
  tone: StatusDotTone;
  label: string;
  detail: string;
  action: string;
  /** What the action is for, when the word alone ("Set up") would be ambiguous among the lines. */
  actionName?: string;
  folded: boolean;
  /** The line itself: opens the page that has the fix. */
  onOpen: () => void;
  /** The action; opens the same page unless it fixes the problem right here. */
  onAct?: () => void;
}) {
  return (
    <div className="sidebar-source">
      <Tooltip content={folded ? `${label} · ${detail}` : null}>
        <button
          type="button"
          className="sidebar-source-line"
          onClick={onOpen}
          aria-describedby={id}
        >
          <span className="sidebar-source-label">
            <StatusDot tone={tone} size={10} />
            {label}
          </span>
          <small id={id}>{detail}</small>
        </button>
      </Tooltip>
      <Button
        variant="ghost"
        size="sm"
        data-rail-hidden=""
        aria-label={actionName}
        onClick={onAct}
      >
        {action}
      </Button>
    </div>
  );
}

export function SourceStatusFooter() {
  const now = useNow();
  const { entries, github } = useSources();
  const { refreshing, sources, refreshAll, openSettings, intervalSecs } =
    useSourceActivity();
  // Only the folded rail hides the two lines, so only it repeats them.
  const { sidebarCollapsed } = usePreferences();
  const isMobile = useIsMobile();
  const folded = sidebarCollapsed && !isMobile;
  const synced = useSyncStatus().status?.connection === "connected";
  // An open report keeps detailed logging on until it is saved, so the line stays
  // visible, as a reminder, wherever the person is.
  const loggingSince = useDetailedLogging();
  const openSettingsPage = useContext(SettingsNavigation);
  useEffect(() => {
    void refreshDetailedLogging();
  }, []);
  // What needs the person, from the one model the Settings nav marks read too.
  const needs = useNeeds();
  const needing = (kind: string) => needs.some((need) => need.kind === kind);
  const updates = useUpdates();
  const update = updateNeedsYou(updates?.snapshot ?? null);
  const updateInfo =
    updates && "update" in updates.snapshot && updates.snapshot.update
      ? updates.snapshot.update
      : null;
  // A connection whose extension is missing has no health to show; say it here.
  const sourceNeeds = sourcesNeedYou(entries, sources, github);
  const githubNeed = sourceNeeds.find((row) => row.id === "github");
  const missing = sourceNeeds.filter(
    (row) =>
      row.status === "Unavailable" &&
      row.entry?.saved &&
      !sources.some((status) => status.connection_id === row.entry?.saved?.id),
  );
  const open =
    (page: Parameters<NonNullable<typeof openSettingsPage>>[0]) => () =>
      openSettingsPage?.(page);
  // Beyond the sync and source lines, what else the group says.
  const others =
    needing("command-line") ||
    needing("agent-skills") ||
    !!update ||
    missing.length > 0 ||
    !!githubNeed;
  if (sources.length === 0 && !synced && !loggingSince && !others) return null;
  return (
    <div
      className="sidebar-sources"
      role="group"
      aria-label={
        others
          ? "Status"
          : !synced
            ? sources.length > 0
              ? "Ticket sources"
              : "Detailed logging"
            : sources.length > 0
              ? "Sync and ticket sources"
              : "Sync"
      }
    >
      {synced && <SyncStatusLine />}
      {needing("command-line") && (
        <NeedLine
          id="sidebar-command-line"
          tone="attention"
          label="Command needs setup"
          detail="Agents can’t use ticketd yet"
          action="Set up"
          actionName="Set up the command line"
          folded={folded}
          onOpen={open("command-line")}
        />
      )}
      {needing("agent-skills") && (
        <NeedLine
          id="sidebar-agent-skills"
          tone="attention"
          label="Skills need setup"
          detail="An agent doesn’t know ticketd"
          action="Set up"
          actionName="Set up agent skills"
          folded={folded}
          onOpen={open("agent-skills")}
        />
      )}
      {update && updateInfo && (
        <NeedLine
          id="sidebar-update"
          tone={update === "ready" ? "unread" : "attention"}
          label={
            update === "ready"
              ? "Update ready"
              : update === "available"
                ? "Update available"
                : "Update failed"
          }
          detail={`ticketd ${updateInfo.version}`}
          action={update === "ready" ? "Restart" : "Open About"}
          {...(update === "ready" && { actionName: "Restart to update" })}
          folded={folded}
          onOpen={open("about")}
          onAct={
            update === "ready" && updates
              ? () => updates.openRestart(updateInfo)
              : open("about")
          }
        />
      )}
      {loggingSince && (
        <NeedLine
          id="sidebar-detailed-logging"
          tone="attention"
          label="Detailed logging is on"
          detail={`Started ${relativeDateTime(loggingSince, now)}`}
          action="Save report"
          folded={folded}
          onOpen={open("diagnostics")}
        />
      )}
      {missing.map((row) => (
        <NeedLine
          key={`missing-${row.id}`}
          id={`sidebar-source-missing-${row.id}`}
          tone="attention"
          label={`${row.name} unavailable`}
          detail="Its extension is missing"
          action="Open"
          actionName={`Open ${row.name}`}
          folded={folded}
          onOpen={() => openSettings(row.id)}
        />
      ))}
      {githubNeed && (
        <NeedLine
          id="sidebar-github-needs"
          tone="attention"
          label={
            githubNeed.status === "Needs sign-in"
              ? "GitHub needs sign-in"
              : "GitHub unavailable"
          }
          detail="Showing saved content"
          action={githubNeed.status === "Needs sign-in" ? "Sign in" : "Open"}
          actionName={
            githubNeed.status === "Needs sign-in"
              ? "Sign in to GitHub"
              : "Open GitHub"
          }
          folded={folded}
          onOpen={() => openSettings("github")}
        />
      )}
      {sources.map((status) => {
        if (status.provider === "github" && githubNeed) return null;
        const connection = status.connection_id;
        const settingsId = status.provider === "github" ? "github" : connection;
        const row = connection
          ? `connection-${connection}`
          : `unassigned-${status.provider}`;
        const name =
          (connection
            ? entries.find((entry) => entry.saved?.id === connection)?.saved
                ?.name
            : undefined) ?? providerName(status.provider, entries);
        const state = sourceLine(status, refreshing);
        const synced = status.last_refreshed_at
          ? ago(status.last_refreshed_at, now)
          : null;
        const warning =
          state === "unavailable" || state === "partial" || state === "delayed";
        const count = status.unavailable_tickets;
        // The account is the problem, so the fix is signing in, not trying again.
        const signedOut =
          state === "unavailable" &&
          !!status.error &&
          SIGNED_OUT.includes(status.error.code);
        const label =
          state === "refreshing"
            ? `Refreshing ${name}…`
            : state === "synced"
              ? `${name} synced`
              : signedOut
                ? `${name} needs sign-in`
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
        const detailId = `sidebar-source-${row}`;
        return (
          <div className="sidebar-source" key={row}>
            <Tooltip content={folded ? `${label} · ${detail}` : null}>
              <button
                type="button"
                className="sidebar-source-line"
                onClick={() => openSettings(settingsId)}
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
                // The rail shows only the dot: "Sign in" opens the line's page,
                // and the line's tooltip names what Retry would retry.
                data-rail-hidden=""
                onClick={() =>
                  signedOut ? openSettings(settingsId) : void refreshAll()
                }
              >
                {signedOut ? "Sign in" : "Retry"}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

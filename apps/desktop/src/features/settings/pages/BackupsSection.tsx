import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  workspaceClient,
  type RestorePoint,
  type RestorePointList,
} from "@/lib/api/workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { plural } from "@/lib/format";
import {
  formatBytes,
  restorePointDay,
  restorePointWhen,
} from "@/features/settings/settings-format";
import { RestoreDialog } from "@/features/settings/RestoreDialog";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import "@/features/settings/restore-review.css";

/** How many restore points show before "Show all". */
const SHOWN = 3;
/** The footer says how much disk the points use only from here. */
const SIZE_SHOWN_FROM = 1024 ** 3;

type Listing =
  | { status: "loading" }
  | { status: "failed"; failure: FailureDescription }
  | { status: "ready"; list: RestorePointList };

/** Why a point that was not a daily one was saved, or nothing for a daily one. */
function labelOf(point: RestorePoint): string | null {
  switch (point.kind) {
    case "daily":
      return null;
    case "manual":
      return "Saved by you";
    case "safety":
      return "Before restoring";
    case "pre_migration":
      return point.update_version
        ? `Before the ${point.update_version} update`
        : "Before an update";
  }
}

/** A reason from the core as a sentence: capitalized, with its full stop. */
function sentence(reason: string) {
  const text = reason.charAt(0).toUpperCase() + reason.slice(1);
  return text.endsWith(".") ? text : `${text}.`;
}

function PointRow({
  point,
  onRestore,
}: {
  point: RestorePoint;
  onRestore: (point: RestorePoint) => void;
}) {
  const when = restorePointWhen(point.saved_at);
  const label = labelOf(point);
  // The time stays on one line; the row's badge and counts give way instead.
  const time = <span className="whitespace-nowrap">{when}</span>;
  const counts = point.summary
    ? `${plural(point.summary.tickets, "ticket")} · ${plural(point.summary.documents, "Document")}`
    : null;
  return (
    <SettingsRow
      tight={!point.problem}
      title={
        label ? (
          <span className="inline-flex flex-wrap items-center gap-x-2">
            {time}
            <Badge size="sm">{label}</Badge>
          </span>
        ) : (
          time
        )
      }
      description={point.problem ? sentence(point.problem) : undefined}
      trailing={
        point.problem ? (
          <span className="settings-hint">Can't be restored</span>
        ) : (
          <>
            {counts && <span className="settings-hint">{counts}</span>}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Restore… ${when}${label ? `, ${label}` : ""}`}
              onClick={() => onRestore(point)}
            >
              Restore…
            </Button>
          </>
        )
      }
    />
  );
}

export type BackupsProps = {
  onRestore: () => Promise<void>;
  onWorkspaceReplaced?: (() => void) | undefined;
  /** Opens Workspace sync, where a restore that turned sync off offers to rejoin. */
  onOpenSync?: (() => void) | undefined;
};

/**
 * Backups & export › Restore points: the copies to come back to, newest first, saved every
 * day, with Back up now and Restore… on each. Restore from a file… opens a copy made
 * elsewhere through the same review.
 */
export function BackupsSection({
  onRestore,
  onWorkspaceReplaced,
  onOpenSync,
}: BackupsProps) {
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // What the review is of: a restore point, or a file the person chose.
  const [restoring, setRestoring] = useState<{
    path: string;
    point?: RestorePoint;
  } | null>(null);
  const saving = useRef(false);
  const read = useCallback(async () => {
    try {
      return {
        status: "ready" as const,
        list: await workspaceClient.restorePoints(),
      };
    } catch (reason) {
      return {
        status: "failed" as const,
        failure: describeFailure(reason, "list the restore points"),
      };
    }
  }, []);
  const load = useCallback(async () => {
    setListing({ status: "loading" });
    setListing(await read());
  }, [read]);
  useEffect(() => {
    // The first read: state starts as "loading", so only the result is set.
    let current = true;
    void read().then((next) => {
      if (current) setListing(next);
    });
    return () => {
      current = false;
    };
  }, [read]);
  async function backUp() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setFailure(null);
    setMessage("");
    try {
      await workspaceClient.saveRestorePoint();
      setMessage("Restore point saved.");
      setListing(await read());
    } catch (reason) {
      setFailure(describeFailure(reason, "save a restore point"));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function chooseFile() {
    setFailure(null);
    try {
      const path = await workspaceClient.chooseBackupFile({
        title: "Choose a ticketd backup",
      });
      if (path !== null) setRestoring({ path });
    } catch (reason) {
      setFailure(describeFailure(reason, "open the file dialog"));
    }
  }
  const points = listing.status === "ready" ? listing.list.points : [];
  const shown = showAll ? points : points.slice(0, SHOWN);
  const older = points.length - shown.length;
  const oldest = points.at(-1);
  const size =
    listing.status === "ready" && listing.list.total_bytes > SIZE_SHOWN_FROM
      ? formatBytes(listing.list.total_bytes)
      : null;
  const summary = [
    older > 0 && oldest
      ? `${older} older, back to ${restorePointDay(oldest.saved_at)}`
      : null,
    size,
  ].filter(Boolean);
  return (
    <>
      <SettingsSection
        title="Restore points"
        caption="Copies to come back to, saved on this computer every day. The last 7 are kept."
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            busy={busy}
            onClick={() => void backUp()}
          >
            <Plus aria-hidden="true" />
            {busy ? "Backing up…" : "Back up now"}
          </Button>
        }
      >
        {listing.status === "failed" ? (
          <FailureState
            size="inline"
            failure={listing.failure}
            onRetry={() => void load()}
          />
        ) : (
          <SettingsList aria-label="Restore points" role="group">
            {listing.status === "loading" && (
              <div role="status" aria-label="Listing the restore points">
                <SettingsRow tight>
                  <Skeleton className="h-2.5 w-45" />
                </SettingsRow>
              </div>
            )}
            {listing.status === "ready" && points.length === 0 && (
              <SettingsRow
                title="No restore points yet"
                description="One is saved the first time ticketd opens each day."
              />
            )}
            {shown.map((point) => (
              <PointRow
                key={point.path}
                point={point}
                onRestore={(chosen) =>
                  setRestoring({ path: chosen.path, point: chosen })
                }
              />
            ))}
            <SettingsListFooter
              actions={
                <SettingsLink onClick={() => void chooseFile()}>
                  Restore from a file…
                </SettingsLink>
              }
            >
              {failure ? (
                <FailureAlert size="compact" failure={failure} />
              ) : (
                <>
                  {summary.join(" · ")}
                  {points.length > SHOWN && (
                    <>
                      {summary.length > 0 && " · "}
                      <SettingsLink onClick={() => setShowAll(!showAll)}>
                        {showAll ? "Show fewer" : "Show all"}
                      </SettingsLink>
                    </>
                  )}
                </>
              )}
            </SettingsListFooter>
          </SettingsList>
        )}
        <p role="status" className="sr-only">
          {message}
        </p>
      </SettingsSection>

      {restoring !== null && (
        <RestoreDialog
          path={restoring.path}
          {...(restoring.point && { point: restoring.point })}
          onClose={() => setRestoring(null)}
          onWorkspaceReplaced={onWorkspaceReplaced}
          onOpenSync={onOpenSync}
          onRestored={async () => {
            await load();
            await onRestore();
          }}
        />
      )}
    </>
  );
}

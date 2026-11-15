import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { PathText } from "@/components/ui/path-text";
import { RevealButton } from "@/components/ui/reveal-button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { workspaceClient, type SafetyBackup } from "@/lib/api/workspace";
import { formatDateTime } from "@/lib/format";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";

const KIND_LABEL: Record<SafetyBackup["kind"], string> = {
  safety: "Before a restore",
  pre_migration: "Before an upgrade",
};

type Listing =
  | { status: "loading" }
  | { status: "failed"; failure: FailureDescription }
  | { status: "ready"; backups: SafetyBackup[] };

function listFailure(reason: unknown) {
  return describeFailure(reason, "list safety backups");
}

/**
 * The safety and pre-migration backups kept next to the workspace. Each one
 * restores through the same review as any other backup: that is how a
 * restore is undone.
 */
export function SafetyBackups({
  onRestore,
}: {
  /** Opens the restore review for this file. */
  onRestore: (path: string) => void;
}) {
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [revealFailure, setRevealFailure] = useState<FailureDescription | null>(
    null,
  );
  const load = useCallback(async () => {
    setListing({ status: "loading" });
    try {
      setListing({
        status: "ready",
        backups: await workspaceClient.safetyBackups(),
      });
    } catch (reason) {
      setListing({ status: "failed", failure: listFailure(reason) });
    }
  }, []);
  useEffect(() => {
    // The first read: state starts as "loading", so only the result is set.
    let current = true;
    workspaceClient
      .safetyBackups()
      .then((backups) => {
        if (current) setListing({ status: "ready", backups });
      })
      .catch((reason: unknown) => {
        if (current)
          setListing({ status: "failed", failure: listFailure(reason) });
      });
    return () => {
      current = false;
    };
  }, []);
  return (
    <SettingsSection
      title="Safety backups"
      caption="Saved next to the workspace before a restore or a format upgrade, with every retained local attachment file. Restore one to undo."
    >
      {listing.status === "failed" ? (
        <FailureState
          size="inline"
          failure={listing.failure}
          onRetry={() => void load()}
        />
      ) : (
        <SettingsList>
          {listing.status === "loading" && (
            <div role="status" aria-label="Listing safety backups">
              <SettingsRow>
                <Skeleton className="h-2.5 w-45" />
                <Skeleton className="mt-2 h-2 w-70" />
              </SettingsRow>
            </div>
          )}
          {listing.status === "ready" && listing.backups.length === 0 && (
            <SettingsRow
              title="No safety backups yet"
              description="One appears here the first time ticketd restores a backup or upgrades the workspace."
            />
          )}
          {listing.status === "ready" &&
            listing.backups.map((backup) => (
              <SettingsRow
                key={backup.path}
                title={
                  <>
                    <span>{KIND_LABEL[backup.kind]}</span>
                    <span className="backups-when">
                      {" · "}
                      {formatDateTime(backup.saved_at)}
                    </span>
                  </>
                }
                description={<PathText path={backup.path} />}
                trailing={
                  <>
                    <RevealButton
                      display="icon"
                      path={backup.path}
                      subject={backup.path}
                      onFailure={setRevealFailure}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Restore… ${backup.path}`}
                      onClick={() => onRestore(backup.path)}
                    >
                      Restore…
                    </Button>
                  </>
                }
              />
            ))}
          {revealFailure && (
            <SettingsListFooter>
              <FailureAlert size="compact" failure={revealFailure} />
            </SettingsListFooter>
          )}
        </SettingsList>
      )}
    </SettingsSection>
  );
}

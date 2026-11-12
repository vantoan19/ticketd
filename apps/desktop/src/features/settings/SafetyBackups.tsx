import { useCallback, useEffect, useState } from "react";
import { FolderOpen, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { workspaceClient, type SafetyBackup } from "@/lib/api/workspace";
import { fileManagerName } from "@/lib/platform";
import { formatDateTime } from "@/lib/format";
import { revealFile } from "@/lib/reveal";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";

const KIND_LABEL: Record<SafetyBackup["kind"], string> = {
  safety: "Before a restore",
  pre_migration: "Before an upgrade",
};

type Listing =
  | { status: "loading" }
  | { status: "failed"; reason: string }
  | { status: "ready"; backups: SafetyBackup[] };

/** The safety and pre-migration backups kept next to the workspace. */
export function SafetyBackups() {
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [revealFailure, setRevealFailure] = useState("");
  const load = useCallback(async () => {
    setListing({ status: "loading" });
    try {
      setListing({
        status: "ready",
        backups: await workspaceClient.safetyBackups(),
      });
    } catch (reason) {
      setListing({ status: "failed", reason: String(reason) });
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
        if (current) setListing({ status: "failed", reason: String(reason) });
      });
    return () => {
      current = false;
    };
  }, []);
  async function reveal(path: string) {
    setRevealFailure((await revealFile(path)) ?? "");
  }
  const manager = fileManagerName();
  return (
    <SettingsSection
      title="Safety backups"
      caption="Kept next to the workspace before a restore or a format upgrade, including every retained local attachment file. Restore one the same way as any other backup."
    >
      {listing.status === "failed" ? (
        <Alert tone="error">
          <AlertTitle>Could not list safety backups</AlertTitle>
          <AlertDescription>{listing.reason}</AlertDescription>
          <AlertActions>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
            >
              Try again
            </Button>
          </AlertActions>
        </Alert>
      ) : (
        <SettingsList>
          {listing.status === "loading" && (
            <div role="status" aria-label="Listing safety backups">
              <SettingsRow leading={<SettingsRowTile>{null}</SettingsRowTile>}>
                <Skeleton className="h-2.5 w-45" />
                <Skeleton className="mt-2 h-2 w-70" />
              </SettingsRow>
            </div>
          )}
          {listing.status === "ready" && listing.backups.length === 0 && (
            <SettingsRow
              leading={
                <SettingsRowTile>
                  <ShieldCheck size={20} className="backups-icon-muted" />
                </SettingsRowTile>
              }
              title="No safety backups yet"
              description="One appears here the first time ticketd restores a backup or upgrades the workspace."
            />
          )}
          {listing.status === "ready" &&
            listing.backups.map((backup) => (
              <SettingsRow
                key={backup.path}
                leading={
                  <SettingsRowTile>
                    <ShieldCheck size={20} />
                  </SettingsRowTile>
                }
                title={KIND_LABEL[backup.kind]}
                description={
                  <>
                    {formatDateTime(backup.saved_at)}
                    {" · "}
                    <code className="backups-file">{backup.path}</code>
                  </>
                }
                trailing={
                  <IconButton
                    label={`Show ${backup.path} in ${manager}`}
                    onClick={() => void reveal(backup.path)}
                  >
                    <FolderOpen aria-hidden="true" />
                  </IconButton>
                }
              />
            ))}
          {revealFailure && (
            <SettingsListFooter>
              <p role="alert" className="backups-failure">
                {revealFailure}
              </p>
            </SettingsListFooter>
          )}
        </SettingsList>
      )}
    </SettingsSection>
  );
}

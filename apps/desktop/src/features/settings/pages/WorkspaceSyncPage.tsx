import { WorkspaceSync } from "@/features/sync/WorkspaceSync";
import { useSyncStatus } from "@/features/sync/sync-status";
import { sectionMeta } from "@/features/settings/settings-sections";
import {
  AppliesRightAway,
  SettingsPage,
} from "@/features/settings/layout/SettingsPage";

export function WorkspaceSyncPage({
  onReplaced,
}: {
  /** Called after a download replaced this Workspace. */
  onReplaced: () => Promise<void>;
}) {
  const { status } = useSyncStatus();
  // Once syncing, the desktop's name and options save as they change.
  const settled = status?.connection === "connected" && !status.first_sync;
  return (
    <SettingsPage
      {...sectionMeta("workspace-sync")}
      lede="Keep this workspace in sync between your desktops, through a folder in your own Google Drive or an S3 bucket."
      {...(settled && { endSlot: <AppliesRightAway /> })}
    >
      <WorkspaceSync onReplaced={onReplaced} />
    </SettingsPage>
  );
}

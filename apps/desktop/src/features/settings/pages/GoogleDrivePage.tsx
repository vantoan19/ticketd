import { SyncSettings } from "@/features/sync/SyncSettings";
import { useSyncStatus } from "@/features/sync/sync-status";
import { sectionMeta } from "@/features/settings/settings-sections";
import {
  AppliesRightAway,
  SettingsPage,
} from "@/features/settings/layout/SettingsPage";

export function GoogleDrivePage({
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
      {...sectionMeta("google-drive")}
      lede="Keep this workspace in sync between your desktops through a folder in your own Google Drive."
      {...(settled && { endSlot: <AppliesRightAway /> })}
    >
      <SyncSettings onReplaced={onReplaced} />
    </SettingsPage>
  );
}

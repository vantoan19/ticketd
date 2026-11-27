import { SyncSettings } from "@/features/sync/SyncSettings";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

export function WorkspaceSyncPage({
  onReplaced,
}: {
  /** Called after a download replaced this Workspace. */
  onReplaced: () => Promise<void>;
}) {
  return (
    <SettingsPage {...sectionMeta("workspace-sync")}>
      <SyncSettings onReplaced={onReplaced} />
    </SettingsPage>
  );
}

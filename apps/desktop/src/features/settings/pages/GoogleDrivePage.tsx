import { SyncSettings } from "@/features/sync/SyncSettings";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

export function GoogleDrivePage() {
  return (
    <SettingsPage
      {...sectionMeta("google-drive")}
      lede="Keep this workspace in sync between your desktops through a folder in your own Google Drive."
    >
      <SyncSettings />
    </SettingsPage>
  );
}

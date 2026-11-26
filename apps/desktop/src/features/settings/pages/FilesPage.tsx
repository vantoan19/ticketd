import { AttachmentSettings } from "@/features/settings/AttachmentSettings";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

/** Settings › Files: where the files attached to tickets and Documents are kept. */
export function FilesPage() {
  return (
    <SettingsPage {...sectionMeta("files")}>
      <AttachmentSettings />
    </SettingsPage>
  );
}

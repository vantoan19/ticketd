import { AttachmentSettings } from "@/features/settings/AttachmentSettings";
import { sectionMeta } from "@/features/settings/settings-sections";
import {
  AppliesRightAway,
  SettingsPage,
} from "@/features/settings/layout/SettingsPage";

export function AttachmentsPage() {
  return (
    <SettingsPage
      {...sectionMeta("attachments")}
      lede="Choose where new uploads are stored. Existing attachments stay where they are."
      endSlot={<AppliesRightAway />}
    >
      <AttachmentSettings />
    </SettingsPage>
  );
}

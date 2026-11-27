import { AttentionCard } from "@/features/settings/AttentionCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

export function AttentionPage() {
  return (
    <SettingsPage {...sectionMeta("attention")}>
      <AttentionCard />
    </SettingsPage>
  );
}

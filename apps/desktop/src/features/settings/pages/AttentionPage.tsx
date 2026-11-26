import { AttentionCard } from "@/features/settings/AttentionCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

export function AttentionPage({ onOpenInbox }: { onOpenInbox: () => void }) {
  return (
    <SettingsPage {...sectionMeta("attention")}>
      <AttentionCard onOpenInbox={onOpenInbox} />
    </SettingsPage>
  );
}

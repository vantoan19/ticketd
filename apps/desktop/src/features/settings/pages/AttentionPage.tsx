import { AttentionCard } from "@/features/settings/AttentionCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import {
  AppliesRightAway,
  SettingsPage,
} from "@/features/settings/layout/SettingsPage";

export function AttentionPage({ onOpenInbox }: { onOpenInbox: () => void }) {
  return (
    <SettingsPage
      {...sectionMeta("attention")}
      lede="What reaches your Attention inbox, and when ticketd tells you about it."
      endSlot={<AppliesRightAway />}
    >
      <AttentionCard onOpenInbox={onOpenInbox} />
    </SettingsPage>
  );
}

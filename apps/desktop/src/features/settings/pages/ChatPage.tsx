import { Badge } from "@/components/ui/badge";
import { ExperimentalCard } from "@/features/chats/ExperimentalCard";
import { NotificationsCard } from "@/features/chats/NotificationsCard";
import { useChatFeature } from "@/features/chats/use-chats";
import { sectionMeta } from "@/features/settings/settings-sections";
import {
  AppliesRightAway,
  SettingsPage,
} from "@/features/settings/layout/SettingsPage";

export function ChatPage() {
  const { enabled } = useChatFeature();
  return (
    <SettingsPage
      {...sectionMeta("chat")}
      titleAccessory={<Badge size="sm">Experimental</Badge>}
      lede="Work with Claude Code or Codex from ticketd, using the copy installed on this computer."
      endSlot={<AppliesRightAway />}
    >
      <ExperimentalCard />
      {enabled && <NotificationsCard />}
    </SettingsPage>
  );
}

import { Badge } from "@/components/ui/badge";
import { ExperimentalCard } from "@/features/chats/ExperimentalCard";
import { NotificationsCard } from "@/features/chats/NotificationsCard";
import { useChatFeature } from "@/features/chats/use-chats";
import { ChatHarnesses } from "@/features/settings/ChatHarnesses";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

/** Settings › Agents: the Chats switch and the agents on this computer. */
export function AgentsPage() {
  const { enabled } = useChatFeature();
  return (
    <SettingsPage
      {...sectionMeta("agents")}
      titleAccessory={<Badge variant="experimental">Experimental</Badge>}
    >
      <ExperimentalCard />
      {enabled && <ChatHarnesses />}
      {enabled && <NotificationsCard />}
    </SettingsPage>
  );
}

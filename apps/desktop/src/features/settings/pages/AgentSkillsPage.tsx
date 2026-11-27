import { AgentSkillsCard } from "@/features/settings/AgentSkillsCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

export function AgentSkillsPage() {
  const { refreshIndicators } = useSettingsState();
  return (
    <SettingsPage {...sectionMeta("agent-skills")}>
      <AgentSkillsCard onChanged={() => refreshIndicators("agent-skills")} />
    </SettingsPage>
  );
}

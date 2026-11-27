import { CommandLineCard } from "@/features/settings/CommandLineCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

export function CommandLinePage() {
  const { refreshIndicators } = useSettingsState();
  return (
    <SettingsPage {...sectionMeta("command-line")}>
      <CommandLineCard onChecked={() => refreshIndicators("command-line")} />
    </SettingsPage>
  );
}

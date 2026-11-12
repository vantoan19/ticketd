import { CommandLineCard } from "@/features/settings/CommandLineCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

export function CommandLinePage() {
  const { refreshIndicators } = useSettingsState();
  return (
    <SettingsPage
      {...sectionMeta("command-line")}
      lede="The ticketd executable that you, your scripts and your coding agents call. It reads and writes the same workspace as this app."
    >
      <CommandLineCard onChecked={() => refreshIndicators("command-line")} />
    </SettingsPage>
  );
}

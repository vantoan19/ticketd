import { CommandLineCard } from "@/features/settings/CommandLineCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

export function CommandLinePage() {
  const { refreshIndicators } = useSettingsState();
  return (
    <SettingsPage
      {...sectionMeta("command-line")}
      lede={
        <>
          Agents and terminals run <code className="font-mono">ticketd</code> by
          name to read and write the same workspace as this app.
        </>
      }
    >
      <CommandLineCard onChecked={() => refreshIndicators("command-line")} />
    </SettingsPage>
  );
}

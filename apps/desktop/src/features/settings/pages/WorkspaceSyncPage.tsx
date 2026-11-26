import { WorkspaceSync } from "@/features/sync/WorkspaceSync";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

export function WorkspaceSyncPage({
  onReplaced,
}: {
  /** Called after a download replaced this Workspace. */
  onReplaced: () => Promise<void>;
}) {
  return (
    <SettingsPage {...sectionMeta("workspace-sync")}>
      <WorkspaceSync onReplaced={onReplaced} />
    </SettingsPage>
  );
}

import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import {
  BackupsSection,
  type BackupsProps,
} from "@/features/settings/pages/BackupsSection";
import { ExportSection } from "@/features/settings/pages/ExportSection";
import { LocationSection } from "@/features/settings/pages/LocationSection";

/**
 * Settings › Backups & export: where the Workspace file is, the copies to go
 * back to, and the copies to take elsewhere. One job, so one page.
 */
export function BackupsExportPage(props: BackupsProps) {
  return (
    <SettingsPage {...sectionMeta("backups-export")}>
      <LocationSection />
      <BackupsSection {...props} />
      <ExportSection />
    </SettingsPage>
  );
}

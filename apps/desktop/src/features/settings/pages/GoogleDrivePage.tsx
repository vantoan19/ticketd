import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DriveSetupNotice } from "@/features/attachments/DriveSetupNotice";
import {
  SettingsList,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { sectionMeta } from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { attachments, type DriveConfiguration } from "@/lib/api/attachments";

/**
 * Settings › Google Drive: what Google Drive does for attachments. Syncing the
 * Workspace is its own page, whichever storage it uses.
 */
export function GoogleDrivePage() {
  const { openPage } = useSettingsState();
  const [configuration, setConfiguration] = useState<DriveConfiguration | null>(
    null,
  );
  useEffect(() => {
    let current = true;
    attachments
      .driveConfiguration()
      .then((read) => {
        if (current) setConfiguration(read);
      })
      .catch(() => {
        // The attachment picker still reports why Drive cannot start.
      });
    return () => {
      current = false;
    };
  }, []);
  return (
    <SettingsPage
      {...sectionMeta("google-drive")}
      lede="Attach files from your Google Drive, or keep new uploads there. ticketd only sees the files you choose."
    >
      <div className="mt-6">
        {configuration && !configuration.configured && (
          <DriveSetupNotice configuration={configuration} />
        )}
        <SettingsList>
          <SettingsRow
            title="Attach from Drive"
            description="Choose Google Drive in the attachment picker. You sign in with Google the first time."
          />
          <SettingsRow
            title="Upload destination"
            description="New uploads can go to a folder in your Drive instead of this computer."
            trailing={
              <Button
                size="sm"
                variant="outline"
                onClick={() => openPage("attachments")}
              >
                Open Attachments
              </Button>
            }
          />
          <SettingsRow
            title="Workspace sync"
            description="Keeping this workspace on every desktop has its own page, for Google Drive or S3."
            trailing={
              <Button
                size="sm"
                variant="outline"
                onClick={() => openPage("workspace-sync")}
              >
                Open Workspace sync
              </Button>
            }
          />
        </SettingsList>
      </div>
    </SettingsPage>
  );
}

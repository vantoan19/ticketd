import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import type { DriveConfiguration } from "@/lib/api/attachments";

/**
 * Google Drive isn't set up: one plain line and the way to Settings › Files
 * (shell AT-20), where Drive is chosen for new uploads. The technical setup text stays folded under "Setup
 * instructions" for whoever builds ticketd.
 */
export function DriveSetupNotice({
  configuration,
  onOpenSettings,
}: {
  configuration: DriveConfiguration;
  onOpenSettings?: (() => void) | undefined;
}) {
  if (configuration.configured) return null;
  return (
    <div className="attachment-drive-setup">
      <p role="status">Google Drive isn't set up on this computer.</p>
      {onOpenSettings && (
        <Button
          type="button"
          variant="link"
          size="inline"
          className="self-start"
          onClick={onOpenSettings}
        >
          Open Files settings
        </Button>
      )}
      <Disclosure label="Setup instructions">
        <p className="attachment-hint wrap-anywhere">{configuration.message}</p>
      </Disclosure>
    </div>
  );
}

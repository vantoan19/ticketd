import { Disclosure } from "@/components/ui/disclosure";
import type { DriveConfiguration } from "@/lib/api/attachments";

export function DriveSetupNotice({
  configuration,
}: {
  configuration: DriveConfiguration;
}) {
  if (configuration.configured) return null;
  return (
    <>
      <p role="status">Google Drive setup is required before connecting.</p>
      <Disclosure label="Setup instructions">
        <p className="attachment-hint wrap-anywhere">{configuration.message}</p>
      </Disclosure>
    </>
  );
}

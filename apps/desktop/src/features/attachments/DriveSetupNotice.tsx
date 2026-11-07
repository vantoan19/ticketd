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
      <details className="attachment-hint">
        <summary className="cursor-pointer">Setup instructions</summary>
        <p className="mt-2 wrap-anywhere">{configuration.message}</p>
      </details>
    </>
  );
}

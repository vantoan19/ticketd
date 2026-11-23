import { useState } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { S3Connected, S3Setup } from "./S3Setup";
import { SyncSettings } from "./SyncSettings";
import { useSyncStatus } from "./sync-status";
import "./sync.css";

type Storage = "google_drive" | "s3";

/**
 * Settings › Workspace sync: the storage this Workspace syncs through. Until a
 * storage is connected the person chooses one; after that the page is that
 * storage's own, since one Workspace has one storage.
 */
export function WorkspaceSync({
  onReplaced,
}: {
  /** Called after a download replaced this Workspace. */
  onReplaced: () => Promise<void>;
}) {
  const { status } = useSyncStatus();
  const [chosen, setChosen] = useState<Storage>("google_drive");
  const connected = status !== null && status.connection !== "not_connected";
  const storage: Storage = connected ? status.provider : chosen;
  return (
    <>
      {status && !connected && (
        <div className="mt-6">
          <SegmentedControl
            aria-label="Storage"
            value={chosen}
            onValueChange={setChosen}
            options={[
              { value: "google_drive", label: "Google Drive" },
              { value: "s3", label: "S3" },
            ]}
          />
        </div>
      )}
      {storage === "s3" ? (
        connected ? (
          <S3Connected status={status} />
        ) : (
          <S3Setup />
        )
      ) : (
        <SyncSettings onReplaced={onReplaced} />
      )}
    </>
  );
}

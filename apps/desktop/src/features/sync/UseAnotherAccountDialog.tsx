import { useEffect, useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { attachments } from "@/lib/api/attachments";
import "./sync.css";

/** What Workspace sync is doing with the Google account today. */
export type SyncWithAccount = "syncing" | "choosing" | "off";

/**
 * "Use another Google account?", on Files and on Workspace sync alike. There is one Google
 * sign-in for both, so switching it changes both, and the dialog names both before anything
 * changes. The sign-in itself starts when it is confirmed.
 */
export function UseAnotherAccountDialog({
  open,
  onOpenChange,
  account,
  sync,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account in use now, when it is known. */
  account: string | null;
  sync: SyncWithAccount;
  onConfirm: () => void;
}) {
  // Whether new files go to Google Drive: read when the dialog opens, since a Drive folder
  // belongs to the account it was chosen with.
  const [filesOnDrive, setFilesOnDrive] = useState(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    attachments
      .uploadDestination()
      .then((destination) => {
        if (current) setFilesOnDrive(destination.kind === "google_drive");
      })
      .catch(() => {
        // Without it the dialog says what happens when Files use Drive.
        if (current) setFilesOnDrive(true);
      });
    return () => {
      current = false;
    };
  }, [open]);
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Use another Google account?"
      description={`Files and Workspace sync use one Google account${account ? `, ${account}` : ""}. Switching changes both.`}
      primaryLabel="Use another account"
      blockedReason={null}
      size="sm"
      onSubmit={onConfirm}
    >
      <dl className="sync-summary">
        <dt>Workspace sync</dt>
        <dd>
          {sync === "syncing"
            ? "Stops on this computer until you choose a Workspace in the new account"
            : sync === "choosing"
              ? "Continues with the new account"
              : "Uses the new account when you set it up"}
        </dd>
        <dt>New files</dt>
        <dd>
          {filesOnDrive
            ? "Are kept on this computer until you choose Google Drive again"
            : "Use the new account if you choose Google Drive"}
        </dd>
        <dt>In Google Drive</dt>
        <dd>Your files stay where they are. Nothing is deleted</dd>
      </dl>
    </DialogShell>
  );
}

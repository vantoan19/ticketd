import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { workspaceClient, type SafetyBackup } from "@/lib/api/workspace";
import { fileManagerName } from "@/lib/platform";
import { formatDateTime } from "@/lib/format";
import { revealFile } from "@/lib/reveal";

const KIND_LABEL: Record<SafetyBackup["kind"], string> = {
  safety: "Before a restore",
  pre_migration: "Before an upgrade",
};

/** The safety and pre-migration backups kept next to the workspace. */
export function SafetyBackups() {
  const [backups, setBackups] = useState<SafetyBackup[] | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let current = true;
    workspaceClient
      .safetyBackups()
      .then((value) => {
        if (current) setBackups(value);
      })
      .catch((reason: unknown) => {
        if (current)
          setFailure(`Could not list safety backups: ${String(reason)}`);
      });
    return () => {
      current = false;
    };
  }, []);
  async function reveal(path: string) {
    setFailure((await revealFile(path)) ?? "");
  }
  return (
    <div className="safety-backups" role="region" aria-label="Safety backups">
      <p className="settings-hint">
        ticketd keeps a copy next to the workspace before it restores a backup
        or upgrades the workspace format, including every retained local
        attachment file. Restore one the same way as any other backup.
      </p>
      {backups && backups.length === 0 && (
        <p className="settings-hint">No safety backups yet.</p>
      )}
      {backups && backups.length > 0 && (
        <ul>
          {backups.map((backup) => (
            <li key={backup.path}>
              <div>
                <p className="settings-label">
                  {KIND_LABEL[backup.kind]}{" "}
                  <span className="settings-hint">
                    {formatDateTime(backup.saved_at)}
                  </span>
                </p>
                <code className="safety-backup-path">{backup.path}</code>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Show ${backup.path} in ${fileManagerName()}`}
                onClick={() => void reveal(backup.path)}
              >
                <FolderOpen aria-hidden="true" />
                Show in {fileManagerName()}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
    </div>
  );
}

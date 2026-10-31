import { useState } from "react";
import { client } from "@/lib/api/client";

export function WorkspaceSettings({
  onRestore,
  hidden,
}: {
  hidden: boolean;
  onRestore: () => Promise<void>;
}) {
  const [backupPath, setBackupPath] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [exportPath, setExportPath] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  return (
    <div className="management" hidden={hidden}>
      <h1>Workspace settings</h1>
      <p>Manage your workspace data.</p>
      <div className="settings-card">
        <h2>Backup & restore</h2>{" "}
        <section aria-label="Workspace backup">
          <label>
            Backup file path{" "}
            <input
              value={backupPath}
              onChange={(event) => setBackupPath(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!backupPath || backupBusy}
            onClick={() =>
              void (async () => {
                setBackupBusy(true);
                try {
                  setBackupMessage(await client.backupWorkspace(backupPath));
                } catch (reason) {
                  setBackupMessage(`Backup failed: ${String(reason)}`);
                } finally {
                  setBackupBusy(false);
                }
              })()
            }
          >
            Back up
          </button>
          <button
            type="button"
            disabled={!backupPath || backupBusy}
            onClick={() =>
              void (async () => {
                if (
                  !window.confirm(
                    "Restore this backup? Current workspace data will be replaced after a safety backup is made.",
                  )
                )
                  return;
                setBackupBusy(true);
                try {
                  setBackupMessage(await client.restoreWorkspace(backupPath));
                  await onRestore();
                } catch (reason) {
                  setBackupMessage(`Restore failed: ${String(reason)}`);
                } finally {
                  setBackupBusy(false);
                }
              })()
            }
          >
            Restore backup
          </button>
          <p role="status">{backupMessage}</p>
        </section>
      </div>
      <div className="settings-card">
        <h2>Export</h2>{" "}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setExportMessage("");
            void client
              .exportWorkspace(exportPath)
              .then(() => setExportMessage("Export saved."))
              .catch((reason: unknown) =>
                setExportMessage(`Export failed: ${String(reason)}`),
              );
          }}
        >
          <label>
            Export file path{" "}
            <input
              className="rounded border border-neutral-400 bg-white p-2"
              value={exportPath}
              onChange={(event) => setExportPath(event.target.value)}
              required
            />
          </label>{" "}
          <button type="submit">Export workspace</button>
          {exportMessage && <p role="status">{exportMessage}</p>}
        </form>
      </div>
    </div>
  );
}

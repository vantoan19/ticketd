import { useState } from "react";
import { Copy } from "lucide-react";
import { client } from "@/lib/api/client";
import { workspaceClient } from "@/lib/api/workspace";
import { Button } from "@/components/ui/button";
import { writeClipboard } from "@/lib/clipboard";
import { CommandText } from "@/features/settings/CommandText";
import { localDate } from "@/features/settings/settings-format";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

const EXPORT_COMMAND = "ticketd export --file PATH";

function ExportCard() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [message, setMessage] = useState("");
  async function exportWorkspace() {
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      const path = await workspaceClient.chooseSavePath({
        title: "Export ticketd workspace",
        defaultPath: `ticketd-export-${localDate()}.json`,
        filterName: "JSON",
        extension: "json",
      });
      if (path === null) return;
      try {
        await client.exportWorkspace(path);
        setMessage(`Export saved to ${path}.`);
      } catch (reason) {
        setFailure(`The export was not saved: ${String(reason)}`);
      }
    } catch (reason) {
      setFailure(`Could not open the save dialog: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }
  async function copyCommand() {
    const failure = await writeClipboard(EXPORT_COMMAND);
    if (failure === null) setMessage("Command copied.");
    else setFailure(`Could not copy the command: ${failure}`);
  }
  return (
    <SettingsCard id="export" title="Export">
      <div className="settings-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void exportWorkspace()}
        >
          Export…
        </Button>
      </div>
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
      <p role="status" className="settings-hint">
        {message}
      </p>
      <div className="backup-footer">
        <p className="settings-hint">
          A readable JSON snapshot that includes Trash. It is not a backup and
          cannot be imported.
        </p>
        <p className="settings-hint">From the command line:</p>
        <div className="settings-actions">
          <code className="workspace-path">
            <CommandText command={EXPORT_COMMAND} />
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Copy export command"
            onClick={() => void copyCommand()}
          >
            <Copy aria-hidden="true" />
            Copy
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

export function ExportPage() {
  return (
    <SettingsPage
      {...sectionMeta("export")}
      lede="Readable copies of your work for other tools. To keep a copy you can restore, use Backups."
    >
      <ExportCard />
    </SettingsPage>
  );
}

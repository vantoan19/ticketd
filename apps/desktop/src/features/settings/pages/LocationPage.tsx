import { useEffect, useState } from "react";
import { Copy, FolderOpen } from "lucide-react";
import { workspaceClient, type WorkspaceInfo } from "@/lib/api/workspace";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { PathText } from "@/features/projects/PathText";
import { fileManagerName } from "@/lib/platform";
import { writeClipboard } from "@/lib/clipboard";
import { revealFile } from "@/lib/reveal";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function LocationCard() {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [loadFailure, setLoadFailure] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let current = true;
    workspaceClient
      .info()
      .then((value) => {
        if (current) setInfo(value);
      })
      .catch((reason: unknown) => {
        if (current)
          setLoadFailure(`Could not read the workspace: ${String(reason)}`);
      });
    return () => {
      current = false;
    };
  }, []);
  async function copyPath(path: string) {
    const failure = await writeClipboard(path);
    setMessage(
      failure === null ? "Path copied." : `Could not copy the path: ${failure}`,
    );
  }
  async function reveal(path: string) {
    setMessage((await revealFile(path)) ?? "");
  }
  const manager = fileManagerName();
  const facts = info && [
    ["Tickets", String(info.tickets)],
    ["Documents", String(info.documents)],
    ["Projects", String(info.projects)],
    ["Active Plans", String(info.active_plans)],
    ["File size", formatSize(info.size_bytes)],
    ["Format version", String(info.format_version)],
  ];
  return (
    <SettingsCard
      id="location"
      title="Location"
      description="The desktop app and the ticketd command line read and write this workspace."
    >
      {loadFailure && (
        <p role="alert" className="settings-failure">
          {loadFailure}
        </p>
      )}
      {info && facts && (
        <>
          <div className="workspace-location">
            <p className="workspace-path" aria-label="Workspace path">
              <PathText path={info.path} />
            </p>
            <IconButton
              type="button"
              label="Copy path"
              onClick={() => void copyPath(info.path)}
            >
              <Copy aria-hidden="true" />
            </IconButton>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void reveal(info.path)}
            >
              <FolderOpen aria-hidden="true" />
              Show in {manager}
            </Button>
          </div>
          <dl className="workspace-facts">
            {facts.map(([name, value]) => (
              <div key={name} className="workspace-fact">
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <p role="status" className="settings-hint">
        {message}
      </p>
    </SettingsCard>
  );
}

export function LocationPage() {
  return (
    <SettingsPage
      {...sectionMeta("location")}
      lede="The desktop app and the ticketd command line read and write this workspace."
    >
      <LocationCard />
    </SettingsPage>
  );
}

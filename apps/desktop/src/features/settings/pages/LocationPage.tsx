import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  Database,
  FileText,
  FolderOpen,
  Monitor,
  Terminal,
} from "lucide-react";
import { workspaceClient, type WorkspaceInfo } from "@/lib/api/workspace";
import { FailureState } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { PathText } from "@/components/ui/path-text";
import { fileManagerName } from "@/lib/platform";
import { writeClipboard } from "@/lib/clipboard";
import { revealFile } from "@/lib/reveal";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import "./location.css";

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

/** Splits a workspace path into its folder and file name, on either separator. */
function splitFile(path: string) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0
    ? { folder: "", name: path }
    : {
        folder: path.slice(0, cut) || path.slice(0, 1),
        name: path.slice(cut + 1),
      };
}

function LocationSkeleton() {
  return (
    <div
      role="status"
      aria-label="Reading the workspace"
      className="location-skeleton"
    >
      <SettingsSection title="Workspace file">
        <SettingsList>
          <SettingsRow
            leading={<Skeleton className="size-10" />}
            title={<Skeleton className="h-5 w-48" />}
            description={<Skeleton className="mt-1 h-4 w-80 max-w-full" />}
            trailing={<Skeleton className="h-8 w-32" />}
          />
        </SettingsList>
      </SettingsSection>
      <SettingsSection title="One file, two ways in">
        <Skeleton className="h-32 w-full" />
      </SettingsSection>
      <SettingsSection title="Contents">
        <Skeleton className="h-36 w-full" />
      </SettingsSection>
    </div>
  );
}

function Figure({ name }: { name: string }) {
  return (
    <div
      className="location-flow"
      role="img"
      aria-label={`The ticketd desktop app and the ticketd command line both read and write ${name}`}
    >
      <div className="location-node" aria-hidden="true">
        <span className="location-node-icon">
          <Monitor size={18} />
        </span>
        <span className="location-node-title">Desktop app</span>
        <span className="location-node-note">You, in this window</span>
      </div>
      <div className="location-wire" aria-hidden="true">
        <span>reads and writes</span>
      </div>
      <div className="location-node" data-file aria-hidden="true">
        <span className="location-node-icon">
          <Database size={18} />
        </span>
        <span className="location-node-title location-mono">{name}</span>
        <span className="location-node-note">This workspace</span>
      </div>
      <div className="location-wire" aria-hidden="true">
        <span>reads and writes</span>
      </div>
      <div className="location-node" aria-hidden="true">
        <span className="location-node-icon">
          <Terminal size={18} />
        </span>
        <span className="location-node-title">Command line</span>
        <span className="location-node-note">You and your agents</span>
      </div>
    </div>
  );
}

function Loaded({ info }: { info: WorkspaceInfo }) {
  const [message, setMessage] = useState("");
  const manager = fileManagerName();
  const { folder, name } = splitFile(info.path);
  async function copyPath() {
    const failure = await writeClipboard(info.path);
    setMessage(
      failure === null ? "Path copied." : `Couldn't copy the path: ${failure}.`,
    );
  }
  async function reveal() {
    setMessage((await revealFile(info.path)) ?? "");
  }
  const facts = [
    ["Tickets", String(info.tickets)],
    ["Documents", String(info.documents)],
    ["Projects", String(info.projects)],
    ["Active Plans", String(info.active_plans)],
    ["File size", formatSize(info.size_bytes)],
    ["Format version", String(info.format_version)],
  ] as const;
  return (
    <>
      <SettingsSection title="Workspace file">
        <SettingsList>
          <SettingsRow
            leading={
              <SettingsRowTile>
                <FileText size={20} />
              </SettingsRowTile>
            }
            title={<span className="location-mono">{name}</span>}
            description={
              folder && (
                <span className="location-folder">
                  <PathText path={folder} layout="folder" />
                </span>
              )
            }
            trailing={
              <>
                <IconButton label="Copy path" onClick={() => void copyPath()}>
                  <Copy aria-hidden="true" />
                </IconButton>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void reveal()}
                >
                  <FolderOpen aria-hidden="true" />
                  Show in {manager}
                </Button>
              </>
            }
          />
          {message && (
            <SettingsListFooter>
              <span role="status">{message}</span>
            </SettingsListFooter>
          )}
        </SettingsList>
      </SettingsSection>
      <SettingsSection
        title="One file, two ways in"
        caption="Changes made by you in the app and by agents through the command line land in the same file."
      >
        <Figure name={name} />
      </SettingsSection>
      <SettingsSection title="Contents">
        <dl className="location-facts">
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </SettingsSection>
    </>
  );
}

export function LocationPage() {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setFailure(null);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    let current = true;
    workspaceClient
      .info()
      .then((value) => {
        if (current) setInfo(value);
      })
      .catch((reason: unknown) => {
        if (current) setFailure(describeFailure(reason, "read the workspace"));
      });
    return () => {
      current = false;
    };
  }, [attempt]);
  return (
    <SettingsPage
      {...sectionMeta("location")}
      lede="The desktop app and the ticketd command line read and write this workspace."
    >
      {failure ? (
        <SettingsSection title="Workspace file">
          <FailureState
            size="inline"
            failure={{
              ...failure,
              sentence: `${failure.sentence} Reading never changes the workspace.`,
            }}
            onRetry={retry}
          />
        </SettingsSection>
      ) : info ? (
        <Loaded info={info} />
      ) : (
        <LocationSkeleton />
      )}
    </SettingsPage>
  );
}

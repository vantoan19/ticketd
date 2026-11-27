import { useCallback, useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { workspaceClient, type WorkspaceInfo } from "@/lib/api/workspace";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { CopyButton } from "@/components/ui/copy-button";
import { RevealButton } from "@/components/ui/reveal-button";
import { Skeleton } from "@/components/ui/skeleton";
import { PathText } from "@/components/ui/path-text";
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

const count = (value: number, one: string, many = `${one}s`) =>
  `${value} ${value === 1 ? one : many}`;

const CAPTION =
  "The app and the ticketd command both read and write this file.";

function LocationSkeleton() {
  return (
    <div role="status" aria-label="Reading the workspace">
      <SettingsSection title="Location" caption={CAPTION}>
        <SettingsList>
          <SettingsRow
            leading={<Skeleton className="size-10" />}
            title={<Skeleton className="h-5 w-48" />}
            description={<Skeleton className="mt-1 h-4 w-80 max-w-full" />}
            trailing={<Skeleton className="h-8 w-32" />}
          />
        </SettingsList>
      </SettingsSection>
    </div>
  );
}

function Loaded({ info }: { info: WorkspaceInfo }) {
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const { folder, name } = splitFile(info.path);
  // The numbers to compare with `ticketd workspace`, and the format to quote
  // in a bug report.
  const contents = [
    count(info.tickets, "ticket"),
    count(info.documents, "Document"),
    count(info.active_plans, "Plan"),
    formatSize(info.size_bytes),
    `format ${info.format_version}`,
  ].join(" · ");
  return (
    <SettingsSection title="Location" caption={CAPTION}>
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
              <CopyButton text={info.path} label="Copy path" />
              <RevealButton path={info.path} onFailure={setFailure} />
            </>
          }
        />
        <SettingsListFooter>
          {failure ? (
            <FailureAlert size="compact" failure={failure} />
          ) : (
            contents
          )}
        </SettingsListFooter>
      </SettingsList>
    </SettingsSection>
  );
}

/** Backups & export › Location: where the Workspace file is, and what is in it. */
export function LocationSection() {
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
  if (failure)
    return (
      <SettingsSection title="Location" caption={CAPTION}>
        <FailureState
          size="inline"
          failure={{
            ...failure,
            sentence: `${failure.sentence} Reading never changes the workspace.`,
          }}
          onRetry={retry}
        />
      </SettingsSection>
    );
  return info ? <Loaded info={info} /> : <LocationSkeleton />;
}

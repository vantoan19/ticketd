import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import { useRef, useState } from "react";
import { Braces, Check } from "lucide-react";
import { client } from "@/lib/api/client";
import { workspaceClient } from "@/lib/api/workspace";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Button } from "@/components/ui/button";
import { CommandBlock } from "@/components/ui/command-block";
import { PathText } from "@/components/ui/path-text";
import { RevealButton } from "@/components/ui/reveal-button";
import { localDate } from "@/features/settings/settings-format";
import { sectionMeta } from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import "@/features/settings/pages/export-page.css";

function JsonSection() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [savedPath, setSavedPath] = useState("");
  const choosing = useRef(false);
  const lastPath = useRef("");
  async function exportWorkspace() {
    // One save sheet at a time; Exporting… only once a path returns.
    if (choosing.current) return;
    choosing.current = true;
    setFailure(null);
    setSavedPath("");
    try {
      const path = await workspaceClient.chooseSavePath({
        title: "Export ticketd workspace",
        defaultPath: lastPath.current || `ticketd-export-${localDate()}.json`,
        filterName: "JSON",
        extension: "json",
      });
      if (path === null) return;
      lastPath.current = path;
      setBusy(true);
      try {
        await client.exportWorkspace(path);
        setSavedPath(path);
      } catch (reason) {
        setFailure(describeFailure(reason, "save the export"));
      }
    } catch (reason) {
      setFailure(describeFailure(reason, "open the save dialog"));
    } finally {
      choosing.current = false;
      setBusy(false);
    }
  }
  return (
    <SettingsSection title="Workspace as JSON">
      <SettingsList>
        <SettingsRow
          leading={
            <SettingsRowTile>
              <Braces size={20} />
            </SettingsRowTile>
          }
          title="Export as JSON"
          description="One readable snapshot of the workspace, including Trash. It cannot be imported back."
          trailing={
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void exportWorkspace()}
            >
              {busy ? "Exporting…" : "Export…"}
            </Button>
          }
        />
        <SettingsRow
          variant="stacked"
          description="Same export from the command line"
        >
          <CommandBlock
            command="ticketd export --file PATH"
            copyLabel="Copy the export command"
          />
        </SettingsRow>
        {(savedPath || failure) && (
          <SettingsListFooter
            actions={
              savedPath && (
                <RevealButton path={savedPath} onFailure={setFailure} />
              )
            }
          >
            {savedPath && (
              <span role="status" className="export-saved">
                <span className="export-saved-title">
                  <Check size={14} aria-hidden="true" />
                  Export saved
                  <span className="sr-only"> to {savedPath}</span>
                </span>
                <PathText path={savedPath} />
              </span>
            )}
            {failure && (
              <FailureAlert
                size="compact"
                failure={failure}
                onRetry={() => {
                  if (!savedPath) void exportWorkspace();
                  else
                    void workspaceClient.reveal(savedPath).then(
                      () => setFailure(null),
                      (reason: unknown) =>
                        setFailure(describeFailure(reason, "show the export")),
                    );
                }}
              />
            )}
          </SettingsListFooter>
        )}
      </SettingsList>
    </SettingsSection>
  );
}

function MarkdownSection() {
  return (
    <SettingsSection
      title="A ticket or Document as Markdown"
      caption="Portable Markdown with its referenced files and a manifest, written to a new ticketd-export folder. Available from the command line."
    >
      <SettingsList>
        <SettingsRow variant="stacked">
          <div className="export-commands">
            <p className="export-command-label">A ticket</p>
            <CommandBlock
              command="ticketd export-markdown --ticket TICKET --output FOLDER"
              copyLabel="Copy the ticket export command"
            />
            <p className="export-command-label">A Document</p>
            <CommandBlock
              command="ticketd export-markdown --document DOCUMENT --output FOLDER"
              copyLabel="Copy the Document export command"
            />
          </div>
        </SettingsRow>
        <SettingsListFooter>
          Words in color are placeholders. FOLDER must already exist; a new
          folder is created inside it.
        </SettingsListFooter>
      </SettingsList>
    </SettingsSection>
  );
}

const COMPARISON: { label: string; export: string; backup: string }[] = [
  {
    label: "Meant for",
    export: "Reading, other tools, sharing",
    backup: "Restoring this workspace",
  },
  {
    label: "Format",
    export: "JSON or Markdown text",
    backup: "A ticketd workspace file",
  },
  { label: "Includes Trash", export: "Yes", backup: "Yes" },
  { label: "Can be restored", export: "No", backup: "Yes, after a review" },
];

function ComparisonSection() {
  return (
    <SettingsSection title="Export or back up?">
      <table className="export-comparison">
        <caption className="sr-only">Export or back up?</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Compare</span>
            </th>
            <th scope="col">Export</th>
            <th scope="col">Backup</th>
          </tr>
        </thead>
        <tbody>
          {COMPARISON.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td data-negative={row.export === "No" || undefined}>
                {row.export}
              </td>
              <td>{row.backup}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SettingsSection>
  );
}

export function ExportPage() {
  const { openPage } = useSettingsState();
  return (
    <SettingsPage
      {...sectionMeta("export")}
      lede={
        <>
          Readable copies of your work for other tools. To keep a copy you can
          restore, use{" "}
          <SettingsLink onClick={() => openPage("backups")}>
            Backups
          </SettingsLink>
          .
        </>
      }
    >
      <JsonSection />
      <MarkdownSection />
      <ComparisonSection />
    </SettingsPage>
  );
}

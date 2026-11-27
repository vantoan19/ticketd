import { useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
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
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import "@/features/settings/pages/export-page.css";

/** The JSON row, then `children` (the rows under it), then the result of the last export as the list's footer. */
function JsonRows({ children }: { children: ReactNode }) {
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
    <>
      <SettingsRow
        title="Workspace as JSON"
        description="Every ticket, Document and Plan, Trash included, in one file."
        trailing={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void exportWorkspace()}
          >
            {busy ? "Exporting…" : "Export…"}
          </Button>
        }
      />
      {children}
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
    </>
  );
}

function MarkdownRow() {
  return (
    <SettingsRow
      variant="stacked"
      title="A ticket or Document as Markdown"
      description="With its files, from the command line."
    >
      <CommandBlock
        command="ticketd export-markdown --ticket TICKET --output FOLDER"
        copyLabel="Copy the Markdown export command"
      />
    </SettingsRow>
  );
}

/**
 * Backups & export › Export: copies to take the work elsewhere. Not restore
 * points: an export can't be restored.
 */
export function ExportSection() {
  return (
    <SettingsSection
      title="Export"
      caption="Copies to take your work elsewhere, as readable files. An export can't be restored."
    >
      <SettingsList>
        <JsonRows>
          <MarkdownRow />
        </JsonRows>
      </SettingsList>
    </SettingsSection>
  );
}

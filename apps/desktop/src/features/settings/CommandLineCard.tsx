import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ExternalLink, RefreshCw, Terminal } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CommandBlock } from "@/components/ui/command-block";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { StatusLabel } from "@/components/ui/status-label";
import { Step, Steps } from "@/components/ui/steps";
import { workspaceClient } from "@/lib/api/workspace";
import { cliClient, type CliStatus } from "@/lib/api/cli";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { useSettingsState } from "@/features/settings/use-settings-state";

const INSTALL_GUIDE_URL =
  "https://github.com/vantoan19/ticketd/blob/main/docs/install.md";

/** Commands use the CLI's real flags; the capitalized words are placeholders. */
const QUICK_REFERENCE = [
  {
    label: "List Ready tickets for a project",
    command: "ticketd list --project PROJECT_ID --availability ready",
  },
  {
    label: "Read a ticket with relationships, activities, and evidence",
    command: "ticketd context TICKET --relationships --activities --evidence",
  },
  {
    label: "Post an update to a ticket from a file, as an agent",
    command: "ticketd activity add TICKET --file brief.md --agent AGENT",
  },
] as const;

type Check =
  | { phase: "checking" }
  | { phase: "failed" }
  | { phase: "done"; status: CliStatus };

const mono = "font-mono";

/** `onFailure` says why the guide did not open; "" clears it. */
function InstallGuideLink({
  onFailure,
}: {
  onFailure: (message: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => {
        onFailure("");
        workspaceClient
          .openLink(INSTALL_GUIDE_URL)
          .catch((reason: unknown) =>
            onFailure(
              `Could not open the installation guide: ${String(reason)}`,
            ),
          );
      }}
    >
      Installation guide
      <ExternalLink aria-hidden="true" />
    </Button>
  );
}

/** What is wrong with an installed executable, most important first. */
function problems(status: CliStatus): ReactNode[] {
  const found: ReactNode[] = [];
  if (!status.on_path && status.path !== null)
    found.push(
      <>
        Found at <code className={mono}>{status.path}</code>, but that folder
        isn&apos;t on your PATH, so agents and terminals can&apos;t run{" "}
        <code className={mono}>ticketd</code> by name. Move it to a folder on
        your PATH, such as{" "}
        <code className={mono}>{status.suggested_directory}</code> after adding
        that folder to PATH, then check again.
      </>,
    );
  if (status.version === null)
    found.push("ticketd was found but did not report a version.");
  else if (status.version_matches === false)
    found.push(
      `Its version ${status.version} does not match this app (${status.app_version}). Replace it with the ticketd executable from this app's download, then check again.`,
    );
  if (status.workspace_matches === false)
    found.push(
      `It uses a different workspace${status.workspace_path ? ` (${status.workspace_path})` : ""}. Agents would read and write tickets this app does not show. Run both as the same user and environment; on Linux, set XDG_DATA_HOME the same for both.`,
    );
  else if (status.workspace_matches === null)
    found.push(
      "It could not confirm which workspace it uses. Replace it with the ticketd executable from this app's download.",
    );
  return found;
}

/** The terminal tile; the dot says "needs attention" or "ready" beside the words. */
function StatusTile({ tone }: { tone: StatusDotTone }) {
  return (
    <SettingsRowTile>
      <span className="relative flex">
        <Terminal size={20} />
        <span className="absolute -top-0.5 -right-0.5 flex rounded-full ring-2 ring-(--surface)">
          <StatusDot tone={tone} size={10} />
        </span>
      </span>
    </SettingsRowTile>
  );
}

function StatusRows({
  check,
  onGuideFailure,
}: {
  check: Check;
  onGuideFailure: (message: string) => void;
}) {
  if (check.phase === "checking")
    return (
      <div
        role="status"
        aria-label="Checking for the command-line tool"
        className="flex items-center gap-6 px-5 py-4"
      >
        <Skeleton className="size-10" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-30" />
          <Skeleton className="h-2 w-75" />
        </div>
      </div>
    );
  if (check.phase === "failed")
    return (
      <SettingsRow
        leading={<StatusTile tone="neutral" />}
        title="Could not check"
        description="ticketd could not look for the command-line tool. Choose Check again to retry."
      />
    );
  const { status } = check;
  if (!status.found)
    return (
      <>
        <SettingsRow
          leading={<StatusTile tone="attention" />}
          title="Not found"
          description="ticketd is not on your PATH or in the usual install folders."
        />
        <SettingsRow variant="stacked">
          <Steps>
            <Step
              title="Get the ticketd executable"
              description="It comes with this app's download."
              action={<InstallGuideLink onFailure={onGuideFailure} />}
            />
            <Step
              title="Copy it into a folder on your PATH"
              description={
                <>
                  Such as{" "}
                  <code className={mono}>{status.suggested_directory}</code>, so
                  any terminal can run <code className={mono}>ticketd</code>.
                </>
              }
            />
            <Step
              title="Choose Check again"
              description="ticketd confirms its version and which workspace it uses."
            />
          </Steps>
        </SettingsRow>
      </>
    );
  const issues = problems(status);
  const tone: StatusDotTone = issues.length === 0 ? "positive" : "attention";
  const versionTrouble =
    status.version !== null && status.version_matches === false;
  return (
    <>
      <SettingsRow
        leading={<StatusTile tone={tone} />}
        title={
          issues.length === 0
            ? "Installed"
            : status.on_path
              ? "Installed, needs attention"
              : "Found, but not on your PATH"
        }
        description={
          issues.length === 0 ? (
            status.version_matches ? (
              "It matches this app and uses this workspace."
            ) : undefined
          ) : (
            <>
              {issues.map((issue, index) => (
                <span key={index} className="block">
                  {issue}
                </span>
              ))}
            </>
          )
        }
        trailing={
          versionTrouble || !status.on_path ? (
            <InstallGuideLink onFailure={onGuideFailure} />
          ) : null
        }
      />
      <dl className="cli-details">
        <dt>Version</dt>
        <dd>
          <span className={mono}>{status.version ?? "Unknown"}</span>
          {status.version_matches && (
            <span className="text-xs leading-4 text-muted-foreground">
              matches this app
            </span>
          )}
          {versionTrouble && (
            <StatusLabel tone="attention" size="caption">
              differs from this app
            </StatusLabel>
          )}
        </dd>
        <dt>Path</dt>
        <dd>
          <span className={`${mono} break-all`}>
            {status.path ?? "Unknown"}
          </span>
        </dd>
        <dt>Workspace</dt>
        <dd>
          {status.workspace_matches === null ? (
            <StatusLabel tone="neutral">Not confirmed</StatusLabel>
          ) : status.workspace_matches ? (
            <StatusLabel tone="positive">Uses this workspace</StatusLabel>
          ) : (
            <StatusLabel tone="attention">
              Uses a different workspace
            </StatusLabel>
          )}
        </dd>
      </dl>
    </>
  );
}

export function CommandLineCard({
  onChecked,
}: {
  /** Called after each check, so the nav indicator can follow the result. */
  onChecked?: () => void;
}) {
  const { openPage } = useSettingsState();
  const [check, setCheck] = useState<Check>({ phase: "checking" });
  const [guideFailure, setGuideFailure] = useState("");
  const load = useCallback(() => {
    void cliClient.check().then(
      (status) => {
        setCheck({ phase: "done", status });
        onChecked?.();
      },
      () => setCheck({ phase: "failed" }),
    );
  }, [onChecked]);
  // Detect on first show; Check again picks up a later installation.
  useEffect(load, [load]);
  const run = () => {
    setCheck({ phase: "checking" });
    load();
  };
  return (
    <>
      <SettingsSection
        title="Status"
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={check.phase === "checking"}
            onClick={run}
          >
            <RefreshCw aria-hidden="true" />
            Check again
          </Button>
        }
      >
        <SettingsList aria-live="polite">
          <StatusRows check={check} onGuideFailure={setGuideFailure} />
        </SettingsList>
        {guideFailure && (
          <Alert tone="error" size="compact" className="mt-3">
            <AlertDescription>{guideFailure}</AlertDescription>
          </Alert>
        )}
      </SettingsSection>
      <SettingsSection
        title="Quick reference for agents"
        caption="Copy a command, then replace the words in color with your own values."
      >
        <SettingsList>
          {QUICK_REFERENCE.map((item) => (
            <SettingsRow
              key={item.command}
              variant="stacked"
              description={item.label}
            >
              <CommandBlock
                command={item.command}
                copyLabel={`Copy: ${item.label}`}
              />
            </SettingsRow>
          ))}
          <SettingsListFooter
            actions={
              <SettingsLink onClick={() => openPage("agent-skills")}>
                Set up Agent skills
              </SettingsLink>
            }
          >
            Agents learn these commands from the ticketd skill.
          </SettingsListFooter>
        </SettingsList>
      </SettingsSection>
    </>
  );
}

import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { ExternalLink, RefreshCw, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandBlock } from "@/components/ui/command-block";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { PathText } from "@/components/ui/path-text";
import type { StatusDotTone } from "@/components/ui/status-dot";
import { StatusLabel } from "@/components/ui/status-label";
import { Step, Steps } from "@/components/ui/steps";
import { workspaceClient } from "@/lib/api/workspace";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
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

type Failure = { failure: FailureDescription; retry: () => void };
const CHECK_FAILURE: FailureDescription = {
  code: "failed",
  title: "Couldn't check the command-line tool",
  sentence: "Choose Retry to check again.",
  action: "retry",
  details: " ",
};

/** Opens the guide; `onFailure` says why it did not open, and null clears it. */
function InstallGuideLink({
  onFailure,
}: {
  onFailure: (failure: Failure | null) => void;
}) {
  const open = () => {
    onFailure(null);
    workspaceClient.openLink(INSTALL_GUIDE_URL).catch((reason: unknown) =>
      onFailure({
        failure: describeFailure(reason, "open the installation guide"),
        retry: open,
      }),
    );
  };
  return (
    <Button type="button" variant="secondary" size="sm" onClick={open}>
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
        It was found, but that folder isn&apos;t on your PATH, so agents and
        terminals can&apos;t run <code className={mono}>ticketd</code> by name.
        Move it to a folder on your PATH, such as{" "}
        <code className={mono}>{status.suggested_directory}</code>, then check
        again.
      </>,
    );
  if (status.version === null)
    found.push("ticketd was found but did not report a version.");
  else if (status.version_matches === false)
    found.push(
      `Its version ${status.version} does not match this app (${status.app_version}). Replace it with the ticketd executable built or packaged with this version of the app, then check again.`,
    );
  if (status.workspace_matches === false)
    found.push(
      `It uses a different workspace${status.workspace_path ? ` (${status.workspace_path})` : ""}. Agents would read and write tickets this app does not show. Run both as the same user and environment; on Linux, set XDG_DATA_HOME the same for both.`,
    );
  else if (status.workspace_matches === null)
    found.push(
      "It could not confirm which workspace it uses. Replace it with the ticketd executable built or packaged with this version of the app.",
    );
  return found;
}

/** The terminal tile: plain; the status is the StatusLabel beside it. */
function StatusTile() {
  return (
    <SettingsRowTile>
      <Terminal />
    </SettingsRowTile>
  );
}

function StatusRows({
  check,
  onGuideFailure,
}: {
  check: Check;
  onGuideFailure: (failure: Failure | null) => void;
}) {
  if (check.phase === "checking")
    return (
      <>
        <SettingsRow
          leading={<Skeleton className="size-10" />}
          title={<Skeleton className="h-5 w-30" />}
          description={<Skeleton className="h-4 w-75 max-w-full" />}
        />
        <SettingsRow variant="stacked">
          <Steps>
            {[0, 1, 2].map((index) => (
              <Step
                key={index}
                title={<Skeleton className="h-5 w-48 max-w-full" />}
                description={<Skeleton className="h-4 w-75 max-w-full" />}
                {...(index === 0 && {
                  action: <Skeleton className="h-8 w-40" />,
                })}
              />
            ))}
          </Steps>
        </SettingsRow>
      </>
    );
  if (check.phase === "failed")
    return (
      <SettingsRow
        leading={<StatusTile />}
        title={<StatusLabel tone="neutral">Couldn't check</StatusLabel>}
        description="ticketd couldn't look for the command-line tool. Choose Check again to retry."
      />
    );
  const { status } = check;
  if (!status.found)
    return (
      <>
        <SettingsRow
          leading={<StatusTile />}
          title={<StatusLabel tone="attention">Not found</StatusLabel>}
          description="ticketd is not on your PATH or in the usual install folders."
        />
        <SettingsRow variant="stacked">
          <Steps>
            <Step
              title="Get the ticketd executable"
              description={
                <>
                  A packaged download includes it. From a source build, run{" "}
                  <code className={mono}>cargo build -p ticketd-cli</code>.
                </>
              }
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
        leading={<StatusTile />}
        title={
          <StatusLabel tone={tone}>
            {issues.length === 0
              ? "Installed"
              : status.on_path
                ? "Installed, needs attention"
                : "Found, but not on your PATH"}
          </StatusLabel>
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
          <span className="cli-code">{status.version ?? "Unknown"}</span>
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
          {status.path ? (
            <span className="cli-path">
              <PathText path={status.path} layout="inline" />
            </span>
          ) : (
            "Unknown"
          )}
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
  const [checking, setChecking] = useState(true);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [guideFailure, setGuideFailure] = useState<Failure | null>(null);
  const load = () => {
    void cliClient.check().then(
      (status) => {
        setCheck({ phase: "done", status });
        setChecking(false);
        onChecked?.();
      },
      (reason: unknown) => {
        setCheck((previous) =>
          previous.phase === "done" ? previous : { phase: "failed" },
        );
        setChecking(false);
        setFailure({
          ...describeFailure(reason, "check the command-line tool"),
          sentence: CHECK_FAILURE.sentence,
        });
      },
    );
  };
  // Detect on first show; Check again picks up a later installation.
  // Reporting the result to the nav is not a reason to start another check.
  const firstCheck = useEffectEvent(load);
  useEffect(() => {
    firstCheck();
  }, []);
  const run = () => {
    setChecking(true);
    setFailure(null);
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
            disabled={checking}
            onClick={run}
          >
            <RefreshCw aria-hidden="true" />
            {checking ? "Checking…" : "Check again"}
          </Button>
        }
      >
        <div className="cli-status-slot" aria-busy={checking}>
          <SettingsList className="cli-status-reserve" aria-hidden="true">
            <StatusRows
              check={{ phase: "checking" }}
              onGuideFailure={() => {}}
            />
          </SettingsList>
          <SettingsList className="cli-status-content" aria-live="polite">
            {check.phase === "checking" && (
              <span className="sr-only" role="status">
                Checking for the command-line tool
              </span>
            )}
            <StatusRows check={check} onGuideFailure={setGuideFailure} />
          </SettingsList>
        </div>
        <div className="cli-check-feedback">
          <div className="cli-check-feedback-reserve" aria-hidden="true">
            <FailureAlert
              size="compact"
              failure={CHECK_FAILURE}
              onRetry={() => {}}
            />
          </div>
          {failure && (
            <FailureAlert size="compact" failure={failure} onRetry={run} />
          )}
        </div>
        {guideFailure && (
          <FailureAlert
            size="compact"
            className="mt-3"
            failure={guideFailure.failure}
            onRetry={guideFailure.retry}
          />
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

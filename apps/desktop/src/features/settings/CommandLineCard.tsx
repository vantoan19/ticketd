import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { CircleCheck, ExternalLink, RefreshCw, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandBlock } from "@/components/ui/command-block";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { PathText } from "@/components/ui/path-text";
import type { StatusDotTone } from "@/components/ui/status-dot";
import { StatusLabel } from "@/components/ui/status-label";
import { Step, Steps } from "@/components/ui/steps";
import { useStatusLine } from "@/components/ui/use-status-line";
import { workspaceClient } from "@/lib/api/workspace";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { cliClient, type CliInstallation, type CliStatus } from "@/lib/api/cli";
import { homeRelative } from "@/lib/paths";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  commandLineFix,
  commandLineKind,
  type CommandLineKind,
} from "@/features/settings/command-line-state";
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
const USER_BIN = "~/.local/bin";

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

/** The word, its dot and the one sentence for each state. */
function describe(
  kind: CommandLineKind,
  status: CliStatus,
  fixable: boolean,
): { tone: StatusDotTone; word: string; sentence: ReactNode } {
  const attention = "attention" as const;
  switch (kind) {
    case "installed":
      return {
        tone: "positive",
        word: "Installed",
        sentence: "Matches this app and uses this Workspace.",
      };
    case "not-installed":
      return {
        tone: attention,
        word: "Not installed",
        sentence: "Agents and terminals can’t run ticketd yet.",
      };
    case "not-on-path":
      return {
        tone: attention,
        word: "Found, but not on your PATH",
        sentence: (
          <>
            That folder isn’t on your PATH, so agents and terminals can’t run{" "}
            <code className={mono}>ticketd</code> by name. Move it to a folder
            on your PATH, such as{" "}
            <code className={mono}>{status.suggested_directory}</code>.
          </>
        ),
      };
    case "older":
    case "newer":
    case "different":
      return {
        tone: attention,
        word: "Doesn’t match this app",
        sentence: `Agents and terminals run ${kind === "older" ? "an older" : kind === "newer" ? "a newer" : "a different"} ticketd than this app.`,
      };
    case "no-version":
      return {
        tone: attention,
        word: "Doesn’t match this app",
        sentence: "Agents and terminals run a ticketd that reports no version.",
      };
    case "other-workspace":
      return {
        tone: attention,
        word: "Uses another Workspace",
        sentence: fixable
          ? "Agents would read and write tickets this app doesn’t show."
          : "Agents would read and write tickets this app doesn’t show. Run both as the same user and environment; on Linux, set XDG_DATA_HOME the same for both.",
      };
    case "workspace-unconfirmed":
      return {
        tone: attention,
        word: "Workspace not confirmed",
        sentence: "This ticketd couldn’t confirm which Workspace it uses.",
      };
  }
}

/** What the fix changes, and when the system asks for a password. */
function fixFooter(
  status: CliStatus,
  installation: CliInstallation | null,
): ReactNode {
  if (installation?.outcome === "declined")
    return "A link in your own folder needs no password.";
  if (installation?.next_step === "add_to_path")
    // A copy left in the way still wins on PATH unless the new folder comes first.
    return status.bundled?.in_the_way
      ? `Put ${USER_BIN} ahead of the older ticketd on your PATH, then open a new terminal and restart your agents.`
      : `Add ${USER_BIN} to your PATH, then open a new terminal.`;
  if (installation?.next_step === "restart_terminals")
    return "Restart terminals and agents to pick it up.";
  const platform = status.bundled?.platform;
  const other = status.bundled?.in_the_way;
  const replaces = other
    ? `Replaces ${other.version ? `ticketd ${other.version}` : "this ticketd"} with this app’s copy.`
    : null;
  if (platform === "windows")
    return `${replaces ?? "Adds this app’s folder to your PATH."} Restart terminals and agents to pick it up.`;
  if (platform === "linux")
    return other
      ? `Removes ${other.version ? `ticketd ${other.version}` : "this ticketd"} so this app’s copy comes first.`
      : null;
  return replaces ? (
    `${replaces} macOS asks for your administrator password once.`
  ) : (
    <>
      Adds ticketd to <code className={mono}>/usr/local/bin</code>. macOS asks
      for your administrator password once.
    </>
  );
}

/** Version, Path and Workspace of the copy that was found; only the wrong fact carries a dot. */
function Facts({ status }: { status: CliStatus }) {
  return (
    <dl className="cli-details">
      <dt>Version</dt>
      <dd>
        <span className="cli-code">{status.version ?? "Unknown"}</span>
        {status.version !== null && status.version_matches === false && (
          <StatusLabel tone="attention" size="caption">
            {`This app has ${status.app_version}`}
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
          "This Workspace"
        ) : (
          <StatusLabel tone="attention">Another Workspace</StatusLabel>
        )}
      </dd>
    </dl>
  );
}

function CheckAgain({
  busy,
  checking,
  onClick,
}: {
  busy: boolean;
  checking: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      busy={busy || checking}
      onClick={onClick}
    >
      <RefreshCw aria-hidden="true" />
      {checking ? "Checking…" : "Check again"}
    </Button>
  );
}

export function CommandLineCard({
  onChecked,
}: {
  /** Called after each check, so the nav indicator can follow the result. */
  onChecked?: () => void;
}) {
  const { openPage } = useSettingsState();
  const statusLine = useStatusLine();
  const [check, setCheck] = useState<Check>({ phase: "checking" });
  const [checking, setChecking] = useState(true);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [guideFailure, setGuideFailure] = useState<Failure | null>(null);
  const [fixing, setFixing] = useState(false);
  const [installation, setInstallation] = useState<CliInstallation | null>(
    null,
  );
  const [installFailure, setInstallFailure] =
    useState<FailureDescription | null>(null);
  // Which install failed, so Retry repeats it: a failure in the folder that
  // needs no password must not send the person back to the password route.
  const [failedInUserBin, setFailedInUserBin] = useState(false);
  /** `quiet` re-reads when the window comes back: no flicker, no failure. */
  const load = (refreshPath = false, quiet = false) => {
    void cliClient.check(refreshPath).then(
      (status) => {
        setCheck({ phase: "done", status });
        // A check that now succeeds outdates an earlier failed one, whichever path ran it.
        setFailure(null);
        setChecking(false);
        onChecked?.();
      },
      (reason: unknown) => {
        if (quiet) return;
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
  // Detect on first show, and again whenever the window regains focus: a
  // person fixes PATH in a terminal, then comes back. Reporting the result to
  // the nav is not a reason to start another check.
  const firstCheck = useEffectEvent(load);
  useEffect(() => {
    firstCheck();
  }, []);
  const recheckOnReturn = useEffectEvent(() => load(true, true));
  useEffect(() => {
    const onFocus = () => recheckOnReturn();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const run = () => {
    setChecking(true);
    setFailure(null);
    setInstallation(null);
    load(true);
  };
  const status = check.phase === "done" ? check.status : null;
  const fix = status ? commandLineFix(status) : null;
  /** Runs the one fix, or installs in the folder that needs no password. */
  const apply = async (inUserBin: boolean) => {
    setFixing(true);
    setInstallFailure(null);
    try {
      const result = inUserBin
        ? await cliClient.installInUserBin()
        : await cliClient.install(fix?.other ?? null);
      setInstallation(result);
      if (result.outcome === "installed") {
        statusLine.show({
          message:
            result.next_step === "restart_terminals"
              ? "Added ticketd to your PATH"
              : fix?.other && !inUserBin
                ? "Now using this app’s ticketd"
                : `Installed ticketd in ${homeRelative(result.directory)}`,
          icon: <CircleCheck />,
        });
        setChecking(true);
        load(true);
      }
    } catch (reason) {
      setFailedInUserBin(inUserBin);
      setInstallFailure(
        describeFailure(reason, "install the command-line tool"),
      );
    } finally {
      setFixing(false);
    }
  };
  const kind = status ? commandLineKind(status) : null;
  const declined = installation?.outcome === "declined";
  // The footer belongs to a fix still to run, or to what a run left to do (a declined
  // password, a PATH step, a restart); after a clean install the Installed state stands alone.
  const aftermath = declined || !!installation?.next_step;
  const footer =
    status && kind && (fix || aftermath)
      ? fixFooter(status, installation)
      : null;
  const view = status && kind ? describe(kind, status, fix !== null) : null;
  return (
    <>
      <section className="settings-section" aria-label="Command line status">
        <SettingsList aria-busy={checking} aria-live="polite">
          {check.phase === "checking" && (
            <>
              <span className="sr-only" role="status">
                Checking for the command-line tool
              </span>
              <SettingsRow
                leading={<Skeleton className="size-10" />}
                title={<Skeleton className="h-5 w-30" />}
                description={<Skeleton className="h-4 w-75 max-w-full" />}
              />
            </>
          )}
          {check.phase === "failed" && (
            <SettingsRow
              leading={<StatusTile />}
              title={<StatusLabel tone="neutral">Couldn't check</StatusLabel>}
              description="ticketd couldn't look for the command-line tool."
              trailing={
                <CheckAgain busy={false} checking={checking} onClick={run} />
              }
            />
          )}
          {status && kind && view && (
            <>
              <SettingsRow
                leading={<StatusTile />}
                title={<StatusLabel tone={view.tone}>{view.word}</StatusLabel>}
                description={declined ? "Nothing changed." : view.sentence}
                trailing={
                  fix ? (
                    <Button
                      type="button"
                      size="sm"
                      busy={fixing || checking}
                      onClick={() => void apply(false)}
                    >
                      {fixing
                        ? "Working…"
                        : kind === "not-installed"
                          ? "Install command-line tool"
                          : "Use this app’s ticketd"}
                    </Button>
                  ) : kind === "installed" || kind === "not-installed" ? (
                    <CheckAgain
                      busy={fixing}
                      checking={checking}
                      onClick={run}
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <InstallGuideLink onFailure={setGuideFailure} />
                      <CheckAgain
                        busy={fixing}
                        checking={checking}
                        onClick={run}
                      />
                    </div>
                  )
                }
              />
              {status.found && <Facts status={status} />}
              {kind === "not-installed" && !fix && (
                <SettingsRow variant="stacked">
                  <Steps>
                    <Step
                      title="Get the ticketd executable"
                      description={
                        <>
                          A packaged download includes it. From a source build,
                          run{" "}
                          <code className={mono}>
                            cargo build -p ticketd-cli
                          </code>
                          .
                        </>
                      }
                      action={<InstallGuideLink onFailure={setGuideFailure} />}
                    />
                    <Step
                      title="Copy it into a folder on your PATH"
                      description={
                        <>
                          Such as{" "}
                          <code className={mono}>
                            {status.suggested_directory}
                          </code>
                          , so any terminal can run{" "}
                          <code className={mono}>ticketd</code>.
                        </>
                      }
                    />
                    <Step
                      title="Choose Check again"
                      description="ticketd confirms its version and which Workspace it uses."
                    />
                  </Steps>
                </SettingsRow>
              )}
              {footer && (
                <SettingsListFooter
                  actions={
                    declined && (
                      <SettingsLink
                        disabled={fixing}
                        onClick={() => void apply(true)}
                      >
                        Use {USER_BIN} instead
                      </SettingsLink>
                    )
                  }
                >
                  {footer}
                </SettingsListFooter>
              )}
            </>
          )}
        </SettingsList>
        {failure && (
          <FailureAlert
            size="compact"
            className="mt-3"
            failure={failure}
            onRetry={run}
          />
        )}
        {guideFailure && (
          <FailureAlert
            size="compact"
            className="mt-3"
            failure={guideFailure.failure}
            onRetry={guideFailure.retry}
          />
        )}
        {installFailure && (
          <FailureAlert
            size="compact"
            className="mt-3"
            failure={installFailure}
            onRetry={() => void apply(failedInUserBin)}
          />
        )}
      </section>
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
                Agent skills
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

/** The terminal tile: plain; the status is the StatusLabel beside it. */
function StatusTile() {
  return (
    <SettingsRowTile>
      <Terminal />
    </SettingsRowTile>
  );
}

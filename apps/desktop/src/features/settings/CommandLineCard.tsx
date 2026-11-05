import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { workspaceClient } from "@/lib/api/workspace";
import { cliClient, type CliStatus } from "@/lib/api/cli";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { CommandText } from "@/features/settings/CommandText";

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

function InstallGuideLink() {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      onClick={() =>
        void workspaceClient.openLink(INSTALL_GUIDE_URL).catch(() => {})
      }
    >
      Installation guide
    </Button>
  );
}

/** What is wrong with an installed executable, most important first. */
function problems(status: CliStatus): ReactNode[] {
  const found: ReactNode[] = [];
  if (!status.on_path && status.path !== null)
    found.push(
      <>
        Found at <code>{status.path}</code>, but that folder isn&apos;t on your
        PATH, so agents and terminals can&apos;t run <code>ticketd</code> by
        name. Move it to a folder on your PATH, such as{" "}
        <code>{status.suggested_directory}</code> after adding that folder to
        PATH, then check again. <InstallGuideLink />
      </>,
    );
  if (status.version === null)
    found.push("ticketd was found but did not report a version.");
  else if (status.version_matches === false)
    found.push(
      <>
        {`Its version ${status.version} does not match this app (${status.app_version}). Replace it with the ticketd executable from this app's download, then check again.`}{" "}
        <InstallGuideLink />
      </>,
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

function Summary({ check }: { check: Check }) {
  if (check.phase === "checking")
    return (
      <p className="settings-label">
        <StatusDot tone="neutral" /> Checking…
      </p>
    );
  if (check.phase === "failed")
    return (
      <>
        <p className="settings-label">
          <StatusDot tone="neutral" /> Could not check
        </p>
        <p className="settings-hint">
          ticketd could not look for the command-line tool. Choose Check again
          to retry.
        </p>
      </>
    );
  const { status } = check;
  if (!status.found)
    return (
      <>
        <p className="settings-label">
          <StatusDot tone="attention" /> Not found
        </p>
        <p className="settings-hint">
          ticketd is not on your PATH or in the usual install folders. Copy the
          ticketd executable from this app&apos;s download into a folder on your
          PATH, such as <code>{status.suggested_directory}</code>, then choose
          Check again. <InstallGuideLink />
        </p>
      </>
    );
  const issues = problems(status);
  const tone: StatusDotTone = issues.length === 0 ? "positive" : "attention";
  return (
    <>
      <p className="settings-label">
        <StatusDot tone={tone} />{" "}
        {issues.length === 0
          ? "Installed"
          : status.on_path
            ? "Installed, needs attention"
            : "Found, but not on your PATH"}
      </p>
      {issues.map((issue, index) => (
        <p key={index} className="settings-hint">
          {issue}
        </p>
      ))}
      <dl className="cli-details">
        <dt>Version</dt>
        <dd>
          {status.version ?? "Unknown"}
          {status.version_matches && " (matches this app)"}
        </dd>
        <dt>Path</dt>
        <dd>
          <code>{status.path}</code>
        </dd>
        <dt>Workspace</dt>
        <dd>
          {status.workspace_matches === null
            ? "Not confirmed"
            : status.workspace_matches
              ? "Uses this workspace"
              : "Uses a different workspace"}
        </dd>
      </dl>
    </>
  );
}

export function CommandLineCard() {
  const [check, setCheck] = useState<Check>({ phase: "checking" });
  const load = useCallback(() => {
    void cliClient.check().then(
      (status) => setCheck({ phase: "done", status }),
      () => setCheck({ phase: "failed" }),
    );
  }, []);
  // Detect on first show; Check again picks up a later installation.
  useEffect(load, [load]);
  const run = () => {
    setCheck({ phase: "checking" });
    load();
  };
  return (
    <SettingsCard id="command-line" title="Command line">
      <div className="settings-row">
        <div className="cli-summary" aria-live="polite">
          <Summary check={check} />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={check.phase === "checking"}
          onClick={run}
        >
          Check again
        </Button>
      </div>
      <h3 className="cli-reference-heading">Quick reference for agents</h3>
      <p className="settings-hint">
        Copy a command, then replace PROJECT_ID, TICKET, and AGENT with your own
        values.
      </p>
      <ul className="cli-reference">
        {QUICK_REFERENCE.map((item) => (
          <li key={item.command}>
            <p className="settings-hint">{item.label}</p>
            <div className="cli-command">
              <code>
                <CommandText command={item.command} />
              </code>
              <CopyButton
                aria-label={`Copy: ${item.label}`}
                text={item.command}
              />
            </div>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

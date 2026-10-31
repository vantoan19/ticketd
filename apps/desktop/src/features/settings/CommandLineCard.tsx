import { useCallback, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { workspaceClient } from "@/lib/api/workspace";
import { cliClient, type CliStatus } from "@/lib/api/cli";
import { SettingsCard } from "@/features/settings/SettingsCard";

const INSTALL_GUIDE_URL =
  "https://github.com/vantoan19/ticketd/blob/main/docs/install.md";

/** Commands use the CLI's real flags; replace the capitalized placeholders. */
const QUICK_REFERENCE = [
  {
    label: "List Ready tickets for a project",
    command: "ticketd list --project PROJECT --availability ready",
  },
  {
    label: "Read a ticket with relationships, notes, and evidence",
    command: "ticketd context TICKET --relationships --notes --evidence",
  },
  {
    label: "Add a note from a file, attributed to an agent",
    command: "ticketd note add TICKET --file note.md --agent AGENT",
  },
] as const;

type Check =
  | { phase: "checking" }
  | { phase: "failed" }
  | { phase: "done"; status: CliStatus };

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "unavailable">(
    "idle",
  );
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Copy: ${label}`}
        onClick={() =>
          void navigator.clipboard.writeText(text).then(
            () => setCopied("copied"),
            () => setCopied("unavailable"),
          )
        }
      >
        {copied === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
        Copy
      </Button>
      <span className="settings-hint" role="status">
        {copied === "copied" && "Copied"}
        {copied === "unavailable" && "Copy unavailable. Select the text."}
      </span>
    </>
  );
}

/** What is wrong with an installed executable, most important first. */
function problems(status: CliStatus): string[] {
  const found: string[] = [];
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
          <StatusDot tone="blocked" /> Not found
        </p>
        <p className="settings-hint">
          ticketd is not on your PATH or in the usual install folders. Copy the
          ticketd executable from this app&apos;s download into a folder on your
          PATH, such as <code>{status.suggested_directory}</code>, then choose
          Check again.{" "}
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
        </p>
      </>
    );
  const issues = problems(status);
  const tone: StatusDotTone = issues.length === 0 ? "ready" : "blocked";
  return (
    <>
      <p className="settings-label">
        <StatusDot tone={tone} />{" "}
        {issues.length === 0 ? "Installed" : "Installed, needs attention"}
      </p>
      {issues.map((issue) => (
        <p key={issue} className="settings-hint">
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
          {status.workspace_matches ? "Uses this workspace" : "Not confirmed"}
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
      <ul className="cli-reference">
        {QUICK_REFERENCE.map((item) => (
          <li key={item.command}>
            <p className="settings-hint">{item.label}</p>
            <div className="cli-command">
              <code>{item.command}</code>
              <CopyButton label={item.label} text={item.command} />
            </div>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

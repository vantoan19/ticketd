import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, FileCheck, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureState } from "@/components/ui/failure-alert";
import { PathText } from "@/components/ui/path-text";
import { Skeleton } from "@/components/ui/skeleton";
import { HarnessMark } from "@/features/chats/HarnessMark";
import type { StatusDotTone } from "@/components/ui/status-dot";
import { StatusLabel } from "@/components/ui/status-label";
import { agentSkillsClient, type AgentSkill } from "@/lib/api/agent-skills";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { useSettingsState } from "@/features/settings/use-settings-state";

type Status = { label: string; tone: StatusDotTone };

const INSTALLED: Status = { label: "Installed", tone: "positive" };
const UPDATE: Status = { label: "Update available", tone: "attention" };
/** A detected agent without the skill needs setup: the nav's dot says the same. */
const NOT_INSTALLED: Status = { label: "Not installed", tone: "attention" };
/** Nothing to install for: no supported agent was found. */
const NOTHING_FOUND: Status = { label: "Not installed", tone: "neutral" };
const ATTENTION: Status = { label: "Needs attention", tone: "attention" };

/** Why a copy is left alone, shown under its row. */
const CONFLICT: Partial<Record<NonNullable<AgentSkill["state"]>, string>> = {
  edited: "Edited after ticketd installed it.",
  other: "Another skill named ticketd is in this folder.",
  not_a_file:
    "SKILL.md here is a link or folder, so ticketd leaves it alone. Remove it, then choose Check again.",
};

/** A harness the one action covers: present on this computer, or already holding a copy. */
function pending(agent: AgentSkill) {
  return (
    agent.state === "update_available" ||
    (agent.state === "not_installed" && agent.detected)
  );
}

function rowStatus(agent: AgentSkill): Status | null {
  switch (agent.state) {
    case "installed":
      return INSTALLED;
    case "update_available":
      return UPDATE;
    case "not_installed":
      return agent.detected ? NOT_INSTALLED : null;
    case null:
      return { label: "Couldn't check", tone: "neutral" };
    default:
      return ATTENTION;
  }
}

function overall(agents: AgentSkill[]): Status {
  if (agents.some((agent) => rowStatus(agent) === ATTENTION || !agent.state))
    return ATTENTION;
  if (agents.some((agent) => agent.state === "update_available")) return UPDATE;
  if (agents.some((agent) => agent.state === "not_installed" && agent.detected))
    return NOT_INSTALLED;
  if (agents.some((agent) => agent.state === "installed")) return INSTALLED;
  return NOTHING_FOUND;
}

/** The one sentence under the skill's status. */
function summary(agents: AgentSkill[], status: Status) {
  if (
    agents.every((agent) => !agent.detected && agent.state === "not_installed")
  )
    return "No supported agent was found, so there is nothing to install yet.";
  const detected = agents.filter((agent) => agent.detected);
  switch (status) {
    case INSTALLED:
      return `Up to date for ${names(detected.filter((agent) => agent.state === "installed"))}.`;
    case UPDATE:
      return "A newer ticketd skill is ready. One click updates it for every supported agent found here.";
    case ATTENTION:
      return "At least one copy needs a look. ticketd leaves a copy alone when it was edited or was not written by ticketd.";
    default:
      return `Not installed for ${names(detected.filter(pending))} yet. One click installs it for every supported agent found here.`;
  }
}

function names(agents: AgentSkill[]) {
  return agents.length > 2
    ? `${agents.length} agents`
    : agents.map((agent) => agent.name).join(" and ");
}

type Load =
  | { phase: "loading" }
  | { phase: "failed"; failure: FailureDescription }
  | { phase: "done"; agents: AgentSkill[] };

const STATUS_ID = "agent-skill-status";

export function AgentSkillsCard({
  onChanged,
}: {
  /** Called after the folders are read again, so the nav indicator can follow. */
  onChanged?: () => void;
}) {
  const { openPage } = useSettingsState();
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Record<string, FailureDescription>>(
    {},
  );
  const [result, setResult] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<AgentSkill | null>(null);
  // An action just finished; its button may be gone, so focus moves to the status.
  const focusAfterLoad = useRef(false);

  const refresh = useCallback(
    () =>
      agentSkillsClient.list().then(
        (agents) => {
          setLoad({ phase: "done", agents });
          onChanged?.();
        },
        (error: unknown) =>
          setLoad({
            phase: "failed",
            failure: describeFailure(error, "check agent skills"),
          }),
      ),
    [onChanged],
  );
  // Read the folders on first show; each action and Check again reads them again.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (load.phase !== "done" || !focusAfterLoad.current) return;
    focusAfterLoad.current = false;
    document.getElementById(STATUS_ID)?.focus();
  }, [load]);

  /** Installs for each agent in turn; one failure does not stop the others. */
  const run = async (agents: AgentSkill[], replace: boolean) => {
    setBusy(true);
    setFailures({});
    setResult(null);
    const failed: Record<string, FailureDescription> = {};
    const done: AgentSkill[] = [];
    let backup: string | null = null;
    for (const agent of agents) {
      try {
        backup = (await agentSkillsClient.install(agent.id, replace)).backup;
        done.push(agent);
      } catch (error) {
        failed[agent.id] = describeFailure(
          error,
          `${replace ? "replace" : "install"} the skill for ${agent.name}`,
        );
      }
    }
    setFailures(failed);
    setResult(
      backup
        ? `Replaced for ${names(done)}. The previous SKILL.md was saved as ${backup}.`
        : done.length > 0
          ? `Done for ${names(done)}.`
          : null,
    );
    setReviewing(null);
    focusAfterLoad.current = true;
    // Keep the action busy until the new state is shown.
    await refresh();
    setBusy(false);
  };

  const checkAgain = () => {
    setFailures({});
    setResult(null);
    setLoad({ phase: "loading" });
    void refresh();
  };

  const agents = load.phase === "done" ? load.agents : [];
  const todo = agents.filter(pending);
  const status = overall(agents);
  const verb = todo.some((agent) => agent.state === "update_available")
    ? "Update"
    : "Install";
  const noneFound = agents.every(
    (agent) => !agent.detected && agent.state === "not_installed",
  );

  return (
    <>
      <SettingsSection title="ticketd skill">
        {load.phase === "failed" ? (
          <FailureState
            size="inline"
            failure={load.failure}
            onRetry={checkAgain}
          />
        ) : (
          <SettingsList>
            {load.phase === "loading" ? (
              <div
                role="status"
                aria-label="Checking agent skills"
                className="flex items-center gap-6 px-5 py-4"
              >
                <Skeleton className="size-10" />
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-2.5 w-30" />
                  <Skeleton className="h-2 w-75" />
                </div>
              </div>
            ) : (
              <SettingsRow
                leading={
                  <SettingsRowTile>
                    <FileCheck size={20} />
                  </SettingsRowTile>
                }
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge>
                      <span className="font-mono">SKILL.md</span>
                    </Badge>
                    <span id={STATUS_ID} tabIndex={-1}>
                      <StatusLabel tone={status.tone}>
                        {status.label}
                      </StatusLabel>
                    </span>
                  </span>
                }
                description={summary(agents, status)}
                trailing={
                  todo.length > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => void run(todo, false)}
                    >
                      {busy ? "Installing…" : `${verb} for ${names(todo)}`}
                    </Button>
                  ) : null
                }
              />
            )}
            {result && (
              <SettingsListFooter>
                <span role="status">{result}</span>
              </SettingsListFooter>
            )}
          </SettingsList>
        )}
      </SettingsSection>
      {load.phase !== "failed" && (
        <SettingsSection
          title="Agents on this computer"
          caption="ticketd installs only for agents it finds. A copy that was edited or not written by ticketd is left alone until you choose Replace."
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy || load.phase === "loading"}
              onClick={checkAgain}
            >
              <RefreshCw aria-hidden="true" />
              Check again
            </Button>
          }
        >
          {load.phase === "loading" ? (
            <SettingsList>
              {[0, 1].map((index) => (
                <div
                  key={index}
                  className="flex items-center gap-6 px-5 py-4"
                  aria-hidden="true"
                >
                  <Skeleton className="size-10" />
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-2.5 w-24" />
                    <Skeleton className="h-2 w-48" />
                  </div>
                </div>
              ))}
            </SettingsList>
          ) : noneFound ? (
            <SettingsList>
              <EmptyState
                icon={<Bot />}
                title="No supported agent was found on this computer"
                description="Install Claude Code or Codex, then choose Check again."
              />
            </SettingsList>
          ) : (
            <SettingsList>
              <div role="list" aria-label="Agents">
                {agents.map((agent) => {
                  const row = rowStatus(agent);
                  const conflict = agent.state
                    ? CONFLICT[agent.state]
                    : undefined;
                  const replaceable =
                    agent.state === "edited" || agent.state === "other";
                  const failure =
                    failures[agent.id] ??
                    (agent.error
                      ? describeFailure(
                          agent.error,
                          `read the skill for ${agent.name}`,
                        )
                      : null);
                  return (
                    <SettingsRow
                      key={agent.id}
                      role="listitem"
                      leading={
                        // The same official marks Chat uses for these agents.
                        <SettingsRowTile>
                          <HarnessMark
                            harness={agent.id}
                            name={agent.name}
                            decorative
                          />
                        </SettingsRowTile>
                      }
                      title={agent.name}
                      description={
                        <span className="agent-skill-path">
                          <PathText path={agent.path} layout="inline" />
                        </span>
                      }
                      trailing={
                        <span className="flex flex-col items-end gap-1">
                          {row ? (
                            <StatusLabel tone={row.tone} size="caption">
                              {row.label}
                            </StatusLabel>
                          ) : (
                            <span className="text-xs leading-4 text-muted-foreground">
                              Not found on this computer
                            </span>
                          )}
                          {conflict && replaceable && (
                            <Button
                              type="button"
                              variant="link"
                              size="xs"
                              aria-label={`Replace for ${agent.name}`}
                              disabled={busy}
                              onClick={() => setReviewing(agent)}
                            >
                              Replace…
                            </Button>
                          )}
                        </span>
                      }
                    >
                      {conflict && (
                        <p className="text-xs leading-4 text-muted-foreground">
                          {conflict}
                        </p>
                      )}
                      {failure && (
                        <FailureState size="inline" failure={failure} />
                      )}
                    </SettingsRow>
                  );
                })}
              </div>
              <SettingsListFooter>
                Agents call ticketd through the command line, so it needs to be
                installed too.{" "}
                <SettingsLink onClick={() => openPage("command-line")}>
                  Check the command line
                </SettingsLink>
              </SettingsListFooter>
            </SettingsList>
          )}
        </SettingsSection>
      )}
      <DialogShell
        open={reviewing !== null}
        onOpenChange={(open) => !open && setReviewing(null)}
        title={`Replace the ${reviewing?.name ?? ""} skill?`}
        description="ticketd will install its own skill in this folder. The current SKILL.md is saved beside it first, so nothing is lost."
        size="md"
        primaryLabel="Replace"
        blockedReason={busy ? "Replacing…" : null}
        busy={busy}
        onSubmit={() => reviewing && void run([reviewing], true)}
      >
        {reviewing && (
          <div className="agent-skill-folder">
            <span className="agent-skill-folder-label">Folder</span>
            <PathText path={reviewing.path} />
          </div>
        )}
      </DialogShell>
    </>
  );
}

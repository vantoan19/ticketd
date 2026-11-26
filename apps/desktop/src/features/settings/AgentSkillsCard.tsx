import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { FileCheck, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureState } from "@/components/ui/failure-alert";
import { PathText } from "@/components/ui/path-text";
import { Skeleton } from "@/components/ui/skeleton";
import { HarnessMark } from "@/features/chats/HarnessMark";
import type { StatusDotTone } from "@/components/ui/status-dot";
import { StatusLabel } from "@/components/ui/status-label";
import { cliClient } from "@/lib/api/cli";
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
/** No supported agent was found: nothing to install for. */
const NOTHING_FOUND: Status = { label: "No agent found", tone: "neutral" };
const LOOK: Status = { label: "Needs a look", tone: "attention" };
/** The skill is there, but the command it calls is not. */
const NO_COMMAND: Status = { label: "No command", tone: "attention" };

/** Why a copy is left alone, shown under its row. */
const CONFLICT: Partial<Record<NonNullable<AgentSkill["state"]>, string>> = {
  edited: "Edited after ticketd installed it.",
  other: "Another skill named ticketd is in this folder.",
  not_a_file:
    "SKILL.md here is a link or folder, so ticketd leaves it alone. Remove it, then choose Check again.",
};

/** Up to date: this build's copy, or one a newer ticketd wrote and nobody changed. */
function installed(agent: AgentSkill) {
  return agent.state === "installed" || agent.state === "newer";
}

/** A harness the one action covers: present on this computer, or already holding a copy. */
function pending(agent: AgentSkill) {
  return (
    agent.state === "update_available" ||
    (agent.state === "not_installed" && agent.detected)
  );
}

/** A copy ticketd leaves alone, or a folder it could not read. */
function needsLook(agent: AgentSkill) {
  return (
    agent.state === null ||
    agent.state === "edited" ||
    agent.state === "other" ||
    agent.state === "not_a_file"
  );
}

function rowStatus(agent: AgentSkill): Status | null {
  if (installed(agent)) return INSTALLED;
  if (agent.state === "update_available") return UPDATE;
  if (agent.state === "not_installed")
    return agent.detected ? NOT_INSTALLED : null;
  return needsLook(agent)
    ? agent.state === null
      ? { label: "Couldn't check", tone: "neutral" }
      : LOOK
    : null;
}

function names(agents: AgentSkill[]) {
  return agents.length > 2
    ? `${agents.length} agents`
    : agents.map((agent) => agent.name).join(" and ");
}

/** Why one copy is left alone, as the status sentence says it. */
function lookSentence(agents: AgentSkill[]) {
  const [agent] = agents;
  if (agents.length > 1 || !agent)
    return `${agents.length} copies need a look, so ticketd left them alone.`;
  switch (agent.state) {
    case "edited":
      return `Your ${agent.name} copy was edited, so ticketd left it alone.`;
    case "other":
      return `Another skill named ticketd is in the ${agent.name} folder, so ticketd left it alone.`;
    case "not_a_file":
      return `SKILL.md in the ${agent.name} folder is a link or folder, so ticketd left it alone.`;
    default:
      return `ticketd couldn't read the ${agent.name} folder.`;
  }
}

/**
 * The status row: one word, one sentence, and the one thing to do about it.
 * The states and their order are the page's design: a copy that needs a look,
 * then an agent to install for, an update that did not happen on its own, a
 * missing command, and last the quiet all-clear.
 */
function describe(agents: AgentSkill[], commandMissing: boolean) {
  const detected = agents.filter((agent) => agent.detected);
  const todo = agents.filter(pending);
  const looks = agents.filter(needsLook);
  const stale = todo.filter((agent) => agent.state === "update_available");
  const fresh = todo.filter((agent) => agent.state === "not_installed");
  if (
    agents.every((agent) => !agent.detected && agent.state === "not_installed")
  )
    return {
      status: NOTHING_FOUND,
      sentence:
        "No agent found. Install Claude Code, Codex or Antigravity, then choose Check again.",
      todo,
      command: false,
    };
  if (looks.length > 0)
    return {
      status: LOOK,
      sentence: lookSentence(looks),
      todo,
      command: false,
    };
  if (stale.length > 0)
    return {
      status: UPDATE,
      sentence: `The ticketd skill for ${names(stale)} is out of date.`,
      todo,
      command: false,
    };
  if (fresh.length > 0) {
    const others = agents.some(installed);
    return {
      status: NOT_INSTALLED,
      sentence:
        fresh.length > 1
          ? `${names(fresh)} don’t have the skill yet.`
          : others
            ? `${names(fresh)} is new on this computer and doesn’t have the skill yet.`
            : `${names(fresh)} doesn’t have the skill yet.`,
      todo,
      command: false,
    };
  }
  if (commandMissing)
    return {
      status: NO_COMMAND,
      sentence: "Agents can’t run ticketd until the command line is installed.",
      todo,
      command: true,
    };
  // A copy can be there before its agent is, e.g. one the CLI installed.
  const found = detected.filter(installed);
  const everyRow = agents.every(installed);
  return {
    status: INSTALLED,
    sentence: everyRow
      ? "Up to date for every agent below. It updates when ticketd does."
      : `Up to date for ${names(found.length > 0 ? found : agents.filter(installed))}. It updates when ticketd does.`,
    todo,
    command: false,
  };
}

type Load =
  | { phase: "loading" }
  | { phase: "failed"; failure: FailureDescription }
  | { phase: "done"; agents: AgentSkill[] };

const STATUS_ID = "agent-skill-status";

function SkillStatusSkeleton() {
  return (
    <SettingsRow
      leading={<Skeleton className="size-10" />}
      title={<StatusLabel tone="neutral">Checking…</StatusLabel>}
      description={
        <Skeleton>
          <span className="invisible">
            Checking the agents on this computer for the ticketd skill.
          </span>
        </Skeleton>
      }
      trailing={<Skeleton className="h-8 w-32" />}
    />
  );
}

export function AgentSkillsCard({
  onChanged,
}: {
  /** Called after the folders are read again, so the nav indicator can follow. */
  onChanged?: () => void;
}) {
  const { openPage } = useSettingsState();
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [checking, setChecking] = useState(true);
  const [checkFailure, setCheckFailure] = useState<FailureDescription | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Record<string, FailureDescription>>(
    {},
  );
  const [result, setResult] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<AgentSkill | null>(null);
  // Whether the command the skill calls is missing; unknown until it is read.
  const [commandMissing, setCommandMissing] = useState(false);
  // An action just finished; its button may be gone, so focus moves to the status.
  const focusAfterLoad = useRef(false);

  const refresh = () => {
    // The command is a hint for the status row only: a failed read says nothing.
    void cliClient.check().then(
      (cli) => setCommandMissing(!cli.found || !cli.on_path),
      () => {},
    );
    return agentSkillsClient.list().then(
      (agents) => {
        setLoad({ phase: "done", agents });
        setChecking(false);
        onChanged?.();
      },
      (error: unknown) => {
        const failure = describeFailure(error, "check agent skills");
        setLoad((previous) =>
          previous.phase === "done" ? previous : { phase: "failed", failure },
        );
        setCheckFailure(failure);
        setChecking(false);
      },
    );
  };
  // Read the folders on first show; each action and Check again reads them again.
  // Reporting the result to the nav is not a reason to start another reading.
  const firstRead = useEffectEvent(() => void refresh());
  useEffect(() => {
    firstRead();
  }, []);
  useEffect(() => {
    if (load.phase !== "done" || !focusAfterLoad.current) return;
    focusAfterLoad.current = false;
    document.getElementById(STATUS_ID)?.focus();
  }, [load]);

  /** Installs for each agent in turn; one failure does not stop the others. */
  const run = async (agents: AgentSkill[], replace: boolean) => {
    setChecking(true);
    setCheckFailure(null);
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
    setChecking(true);
    setCheckFailure(null);
    setFailures({});
    setResult(null);
    void refresh();
  };

  const agents = load.phase === "done" ? load.agents : [];
  const { status, sentence, todo, command } = describe(agents, commandMissing);
  const verb = todo.some((agent) => agent.state === "update_available")
    ? "Update"
    : "Install";

  return (
    <>
      <section className="settings-section" aria-label="Skill status">
        {load.phase === "failed" ? (
          <FailureState
            size="inline"
            failure={load.failure}
            onRetry={checkAgain}
          />
        ) : (
          <div className="skill-status-slot">
            <SettingsList className="skill-status-reserve" aria-hidden="true">
              <SkillStatusSkeleton />
            </SettingsList>
            <SettingsList>
              {load.phase === "loading" ? (
                <div role="status" aria-label="Checking agent skills">
                  <SkillStatusSkeleton />
                </div>
              ) : (
                <SettingsRow
                  leading={
                    <SettingsRowTile>
                      <FileCheck size={20} />
                    </SettingsRowTile>
                  }
                  title={
                    <span id={STATUS_ID} tabIndex={-1}>
                      <StatusLabel tone={status.tone}>
                        {status.label}
                      </StatusLabel>
                    </span>
                  }
                  description={
                    checkFailure ? (
                      <FailureState
                        size="inline"
                        label="Refresh failed"
                        detailsVariant="popover"
                        failure={checkFailure}
                        onRetry={checkAgain}
                      />
                    ) : (
                      sentence
                    )
                  }
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
                    ) : command ? (
                      <SettingsLink onClick={() => openPage("command-line")}>
                        Command line
                      </SettingsLink>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy || checking}
                        onClick={checkAgain}
                      >
                        <RefreshCw aria-hidden="true" />
                        {checking ? "Checking…" : "Check again"}
                      </Button>
                    )
                  }
                />
              )}
              {result && (
                <SettingsListFooter>
                  <span role="status">{result}</span>
                </SettingsListFooter>
              )}
            </SettingsList>
          </div>
        )}
      </section>
      {load.phase !== "failed" && (
        <SettingsSection title="Agents on this computer">
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
                            markId={agent.id}
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
                The skill calls the <code className="font-mono">ticketd</code>
                {" command from "}
                <SettingsLink onClick={() => openPage("command-line")}>
                  Command line
                </SettingsLink>
                {". To run these agents inside ticketd, see "}
                <SettingsLink onClick={() => openPage("agents")}>
                  Agents
                </SettingsLink>
                .
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

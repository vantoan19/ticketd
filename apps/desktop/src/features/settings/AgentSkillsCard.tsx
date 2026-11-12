import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, FileCheck, RefreshCw } from "lucide-react";
import { Alert, AlertActions, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { StatusDotTone } from "@/components/ui/status-dot";
import { StatusLabel } from "@/components/ui/status-label";
import { agentSkillsClient, type AgentSkill } from "@/lib/api/agent-skills";
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
const NOT_INSTALLED: Status = { label: "Not installed", tone: "neutral" };
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
      return { label: "Could not check", tone: "neutral" };
    default:
      return ATTENTION;
  }
}

function overall(agents: AgentSkill[]): Status {
  if (agents.some((agent) => rowStatus(agent) === ATTENTION || !agent.state))
    return ATTENTION;
  if (agents.some((agent) => agent.state === "update_available")) return UPDATE;
  if (agents.some((agent) => agent.state === "installed")) return INSTALLED;
  return NOT_INSTALLED;
}

/** Two letters for an agent's tile: "Claude Code" is CC, "Codex" is CO. */
function initials(name: string) {
  const words = name.split(" ");
  return (
    words.length > 1
      ? words.map((word) => word.charAt(0)).join("")
      : name.slice(0, 2)
  )
    .slice(0, 2)
    .toUpperCase();
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
      return "Not installed for any agent yet. One click installs it for every supported agent found here.";
  }
}

function names(agents: AgentSkill[]) {
  return agents.length > 2
    ? `${agents.length} agents`
    : agents.map((agent) => agent.name).join(" and ");
}

type Load =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "done"; agents: AgentSkill[] };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

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
  const [failures, setFailures] = useState<Record<string, string>>({});
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
          setLoad({ phase: "failed", message: message(error) }),
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
    const failed: Record<string, string> = {};
    const done: AgentSkill[] = [];
    let backup: string | null = null;
    for (const agent of agents) {
      try {
        backup = (await agentSkillsClient.install(agent.id, replace)).backup;
        done.push(agent);
      } catch (error) {
        failed[agent.id] = message(error);
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
          <Alert tone="error">
            <AlertTitle>
              Could not check agent skills: {load.message}
            </AlertTitle>
            <AlertActions>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={checkAgain}
              >
                Try again
              </Button>
            </AlertActions>
          </Alert>
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
            <SettingsList role="list" aria-label="Agents">
              {agents.map((agent) => {
                const row = rowStatus(agent);
                const conflict = agent.state
                  ? CONFLICT[agent.state]
                  : undefined;
                const replaceable =
                  agent.state === "edited" || agent.state === "other";
                const failure = failures[agent.id] ?? agent.error;
                return (
                  <SettingsRow
                    key={agent.id}
                    role="listitem"
                    leading={
                      <SettingsRowTile>
                        <span className="text-xs leading-4 font-medium">
                          {initials(agent.name)}
                        </span>
                      </SettingsRowTile>
                    }
                    title={agent.name}
                    description={
                      <span className="font-mono">{agent.path}</span>
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
                      <p
                        role="alert"
                        className="text-xs leading-4 text-destructive"
                      >
                        {failure}
                      </p>
                    )}
                  </SettingsRow>
                );
              })}
            </SettingsList>
          )}
          <p className="mt-3 text-xs leading-4 text-muted-foreground">
            Agents call ticketd through the command line, so it needs to be
            installed too.{" "}
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => openPage("command-line")}
            >
              Check the command line
            </Button>
          </p>
        </SettingsSection>
      )}
      <DialogShell
        open={reviewing !== null}
        onOpenChange={(open) => !open && setReviewing(null)}
        title={`Replace the ${reviewing?.name ?? ""} skill`}
        description="ticketd will install its own skill in this folder. The current SKILL.md is saved beside it first, so nothing is lost."
        width={573}
        primaryLabel="Replace"
        blockedReason={busy ? "Replacing…" : null}
        busy={busy}
        onSubmit={() => reviewing && void run([reviewing], true)}
      >
        <p className="flex min-h-10 items-center gap-2 rounded-(--radius) bg-(--recessed) px-3 font-mono text-(length:--text-code) leading-5">
          <span className="font-sans text-muted-foreground">Folder</span>
          <code className="min-w-0 break-all">{reviewing?.path}</code>
        </p>
      </DialogShell>
    </>
  );
}

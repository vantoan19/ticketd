import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Separator } from "@/components/ui/separator";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { agentSkillsClient, type AgentSkill } from "@/lib/api/agent-skills";
import { SettingsCard } from "@/features/settings/SettingsCard";

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

export function AgentSkillsCard() {
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
        (agents) => setLoad({ phase: "done", agents }),
        (error: unknown) =>
          setLoad({ phase: "failed", message: message(error) }),
      ),
    [],
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

  return (
    <SettingsCard
      id="agent-skills"
      title="Agent skills"
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || load.phase === "loading"}
          onClick={checkAgain}
        >
          Check again
        </Button>
      }
    >
      {load.phase === "loading" && (
        <p className="settings-hint" aria-live="polite">
          Checking…
        </p>
      )}
      {load.phase === "failed" && (
        <p className="settings-failure" role="alert">
          Could not check agent skills: {load.message}
        </p>
      )}
      {load.phase === "done" && (
        <div className="agent-skill">
          <div className="agent-skill-header">
            <p className="settings-label">ticketd skill</p>
            <span id={STATUS_ID} className="agent-skill-status" tabIndex={-1}>
              <StatusDot tone={status.tone} /> {status.label}
            </span>
          </div>
          <p className="settings-hint">
            Teaches your coding agents to use the ticketd command line. It is
            installed for your user and works in every project.
          </p>
          {todo.length > 0 && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void run(todo, false)}
              >
                {busy ? "Installing…" : `${verb} for ${names(todo)}`}
              </Button>
            </div>
          )}
          {todo.length === 0 &&
            agents.every(
              (agent) => !agent.detected && agent.state === "not_installed",
            ) && (
              <p className="settings-hint">
                No supported agent was found on this computer. Install Claude
                Code or Codex, then choose Check again.
              </p>
            )}
          {result && (
            <p className="settings-hint" role="status">
              {result}
            </p>
          )}
          <Separator />
          <ul className="agent-skill-targets" aria-label="Agents">
            {agents.map((agent) => {
              const row = rowStatus(agent);
              const conflict = agent.state ? CONFLICT[agent.state] : undefined;
              const replaceable =
                agent.state === "edited" || agent.state === "other";
              const failure = failures[agent.id] ?? agent.error;
              return (
                <li key={agent.id}>
                  <span className="agent-skill-target-name">{agent.name}</span>
                  <span className="agent-skill-target-state">
                    {row ? (
                      <>
                        <StatusDot tone={row.tone} /> {row.label}
                      </>
                    ) : (
                      "Not found on this computer"
                    )}
                  </span>
                  <code className="agent-skill-target-path">{agent.path}</code>
                  {(conflict ?? failure) && (
                    <div className="agent-skill-target-note">
                      {conflict && (
                        <div className="agent-skill-conflict">
                          <p className="settings-hint">{conflict}</p>
                          {replaceable && (
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
                        </div>
                      )}
                      {failure && (
                        <p className="settings-failure" role="alert">
                          {failure}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
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
        <p className="settings-hint">
          Folder: <code>{reviewing?.path}</code>
        </p>
      </DialogShell>
    </SettingsCard>
  );
}

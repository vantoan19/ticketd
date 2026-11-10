import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { agentSkillsClient, type AgentSkill } from "@/lib/api/agent-skills";
import { SettingsCard } from "@/features/settings/SettingsCard";

type Action = "Install" | "Update" | "Replace";

const STATE: Record<
  NonNullable<AgentSkill["state"]> | "unreadable",
  { label: string; tone: StatusDotTone; action: Action | null; hint?: string }
> = {
  installed: { label: "Installed", tone: "positive", action: null },
  update_available: {
    label: "Update available",
    tone: "attention",
    action: "Update",
  },
  not_installed: { label: "Not installed", tone: "neutral", action: "Install" },
  edited: {
    label: "Needs attention",
    tone: "attention",
    action: "Replace",
    hint: "The skill was edited after ticketd installed it.",
  },
  other: {
    label: "Needs attention",
    tone: "attention",
    action: "Replace",
    hint: "Another skill named ticketd is in this folder.",
  },
  not_a_file: {
    label: "Needs attention",
    tone: "attention",
    action: null,
    hint: "SKILL.md in this folder is a link or folder, so ticketd leaves it alone. Remove it, then choose Check again.",
  },
  unreadable: { label: "Could not check", tone: "neutral", action: null },
};

type Load =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "done"; agents: AgentSkill[] };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const stateId = (agent: AgentSkill) => `agent-skill-${agent.id}-state`;

export function AgentSkillsCard() {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [reviewing, setReviewing] = useState<AgentSkill | null>(null);
  const [backup, setBackup] = useState<string | null>(null);
  // The row whose action just finished; its button may be gone, so focus moves to its state.
  const focusAfterLoad = useRef<AgentSkill | null>(null);

  const refresh = useCallback(
    () =>
      agentSkillsClient.list().then(
        (agents) => setLoad({ phase: "done", agents }),
        (error: unknown) =>
          setLoad({ phase: "failed", message: message(error) }),
      ),
    [],
  );
  // Read the folders on first show; each install and Check again reads them again.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const agent = focusAfterLoad.current;
    if (load.phase !== "done" || !agent) return;
    focusAfterLoad.current = null;
    document.getElementById(stateId(agent))?.focus();
  }, [load]);

  const install = async (agent: AgentSkill, replace: boolean) => {
    setBusy(agent.id);
    setFailure(null);
    setBackup(null);
    try {
      const result = await agentSkillsClient.install(agent.id, replace);
      setBackup(result.backup);
    } catch (error) {
      setFailure({ id: agent.id, text: message(error) });
    }
    setReviewing(null);
    focusAfterLoad.current = agent;
    // Keep the row busy until the new state is shown.
    await refresh();
    setBusy(null);
  };

  const checkAgain = () => {
    setFailure(null);
    setLoad({ phase: "loading" });
    void refresh();
  };

  return (
    <SettingsCard
      id="agent-skills"
      title="Agent skills"
      description="Teach your coding agents to use the ticketd command line. The skill is installed for your user and works in every project."
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null || load.phase === "loading"}
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
        <ul className="agent-skills">
          {load.agents.map((agent) => {
            const state = STATE[agent.state ?? "unreadable"];
            const action = state.action;
            return (
              <li key={agent.id} className="settings-row">
                <div>
                  <p className="settings-label">
                    {agent.name}
                    <span
                      id={stateId(agent)}
                      className="agent-skill-state"
                      tabIndex={-1}
                    >
                      <StatusDot tone={state.tone} /> {state.label}
                    </span>
                  </p>
                  <p className="settings-hint">
                    <code>{agent.path}</code>
                    {!agent.detected &&
                      ` · ${agent.name} not found on this computer`}
                  </p>
                  {state.hint && <p className="settings-hint">{state.hint}</p>}
                  {agent.error && (
                    <p className="settings-failure" role="alert">
                      {agent.error}
                    </p>
                  )}
                  {failure?.id === agent.id && (
                    <p className="settings-failure" role="alert">
                      {failure.text}
                    </p>
                  )}
                </div>
                {action && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`${action} for ${agent.name}`}
                    disabled={busy !== null}
                    onClick={() =>
                      action === "Replace"
                        ? setReviewing(agent)
                        : void install(agent, false)
                    }
                  >
                    {busy === agent.id
                      ? "Installing…"
                      : action === "Replace"
                        ? "Replace…"
                        : action}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {backup && (
        <p className="settings-hint" role="status">
          The previous skill was saved as <code>{backup}</code>.
        </p>
      )}
      <DialogShell
        open={reviewing !== null}
        onOpenChange={(open) => !open && setReviewing(null)}
        title={`Replace the ${reviewing?.name ?? ""} skill`}
        description="ticketd will install its own skill in this folder. The current SKILL.md is saved beside it first, so nothing is lost."
        width={573}
        primaryLabel="Replace"
        blockedReason={busy !== null ? "Replacing…" : null}
        busy={busy !== null}
        onSubmit={() => reviewing && void install(reviewing, true)}
      >
        <p className="settings-hint">
          Folder: <code>{reviewing?.path}</code>
        </p>
      </DialogShell>
    </SettingsCard>
  );
}

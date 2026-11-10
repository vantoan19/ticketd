import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { agentSkillsClient, type AgentSkill } from "@/lib/api/agent-skills";
import { SettingsCard } from "@/features/settings/SettingsCard";

const STATE: Record<
  AgentSkill["state"],
  { label: string; tone: StatusDotTone; action: string | null; hint?: string }
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
    action: "Replace…",
    hint: "The skill was edited after ticketd installed it.",
  },
  other: {
    label: "Needs attention",
    tone: "attention",
    action: "Replace…",
    hint: "Another skill named ticketd is in this folder.",
  },
};

type Load =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "done"; agents: AgentSkill[] };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function AgentSkillsCard() {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [reviewing, setReviewing] = useState<AgentSkill | null>(null);
  const [backup, setBackup] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      agentSkillsClient.list().then(
        (agents) => setLoad({ phase: "done", agents }),
        (error: unknown) =>
          setLoad({ phase: "failed", message: message(error) }),
      ),
    [],
  );
  // Read the folders on first show; each install reads them again.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = async (agent: AgentSkill, replace: boolean) => {
    setBusy(agent.id);
    setFailure(null);
    try {
      const result = await agentSkillsClient.install(agent.id, replace);
      setBackup(result.backup);
      setReviewing(null);
    } catch (error) {
      setFailure({ id: agent.id, text: message(error) });
      setReviewing(null);
    } finally {
      // Keep the row busy until the new state is shown.
      await refresh();
      setBusy(null);
    }
  };

  return (
    <SettingsCard
      id="agent-skills"
      title="Agent skills"
      description="Teach your coding agents to use the ticketd command line. The skill is installed for your user and works in every project."
    >
      {load.phase === "loading" && (
        <p className="settings-hint" aria-live="polite">
          Checking…
        </p>
      )}
      {load.phase === "failed" && (
        <p className="settings-failure">
          Could not check agent skills: {load.message}
        </p>
      )}
      {load.phase === "done" && (
        <ul className="agent-skills">
          {load.agents.map((agent) => {
            const state = STATE[agent.state];
            return (
              <li key={agent.id} className="settings-row">
                <div>
                  <p className="settings-label">
                    {agent.name}
                    <span className="agent-skill-state">
                      <StatusDot tone={state.tone} /> {state.label}
                    </span>
                  </p>
                  <p className="settings-hint">
                    <code>{agent.path}</code>
                    {!agent.detected &&
                      ` · ${agent.name} not found on this computer`}
                  </p>
                  {state.hint && <p className="settings-hint">{state.hint}</p>}
                  {failure?.id === agent.id && (
                    <p className="settings-failure">{failure.text}</p>
                  )}
                </div>
                {state.action && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      state.action === "Replace…"
                        ? setReviewing(agent)
                        : void install(agent, false)
                    }
                  >
                    {busy === agent.id ? "Installing…" : state.action}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {backup && (
        <p className="settings-hint" aria-live="polite">
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

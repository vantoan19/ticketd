import { agentSkillsClient } from "@/lib/api/agent-skills";
import { cliClient, type CliInstallation } from "@/lib/api/cli";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import type { AgentsAction } from "@/features/setup/setup-state";

export interface AgentInstall {
  /** What the command's install answered; null when the command needed nothing. */
  command: CliInstallation | null;
  /** Agents whose skill was written. */
  installed: string[];
  /** Why a skill could not be written, by agent id. One failure does not stop the others. */
  failures: Record<string, FailureDescription>;
}

/**
 * The one run behind "Install for Claude Code and Codex": first the `ticketd`
 * command, which is the only step that asks for the administrator password,
 * then the skill for each agent that needs one, which is written as the person
 * and asks for nothing. So the password is asked once, and only if the command
 * needs it.
 *
 * A declined password changes nothing and stops here, so the skills are not
 * written under a "Nothing changed". `inUserBin` is that fallback: a link in
 * the person's own folder, which needs no password.
 *
 * Throws when the command could not be installed (the person reads why and
 * retries); a skill that fails is reported in `failures`.
 */
export async function installForAgents(
  action: Extract<AgentsAction, { kind: "install" }>,
  { inUserBin = false }: { inUserBin?: boolean } = {},
): Promise<AgentInstall> {
  let command: CliInstallation | null = null;
  if (action.fix || inUserBin) {
    command = inUserBin
      ? await cliClient.installInUserBin()
      : await cliClient.install(action.fix?.other ?? null);
    if (command.outcome === "declined")
      return { command, installed: [], failures: {} };
  }
  const installed: string[] = [];
  const failures: Record<string, FailureDescription> = {};
  for (const agent of action.skills) {
    try {
      await agentSkillsClient.install(agent.id, false);
      installed.push(agent.id);
    } catch (error) {
      failures[agent.id] = describeFailure(
        error,
        `install the skill for ${agent.name}`,
      );
    }
  }
  return { command, installed, failures };
}

import type { AgentSkill } from "@/lib/api/agent-skills";
import type { CliStatus } from "@/lib/api/cli";

/**
 * True when the Command line page would show the tool as not found or in need
 * of attention (not on PATH, no version, a version or workspace that does not
 * match). The Settings nav shows a "Needs setup" dot for it.
 */
export function cliNeedsSetup(status: CliStatus) {
  return (
    !status.found ||
    !status.on_path ||
    status.version === null ||
    status.version_matches === false ||
    status.workspace_matches !== true
  );
}

/**
 * True when a detected agent lacks the skill, or a copy was edited, is not
 * ticketd's, or could not be read, as the Agent skills page reports it.
 */
export function skillsNeedSetup(agents: AgentSkill[]) {
  return agents.some(
    (agent) =>
      agent.state === null ||
      agent.state === "edited" ||
      agent.state === "other" ||
      agent.state === "not_a_file" ||
      (agent.state === "not_installed" && agent.detected),
  );
}

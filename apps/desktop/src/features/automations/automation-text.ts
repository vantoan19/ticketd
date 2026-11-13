import {
  HARNESS_NAMES,
  type AutomationAgent,
} from "@/features/automations/client";

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/** The last part of a path: the folder's own name. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** What an agent may do, in a sentence: its reach, shown where it is used. */
export function agentReach(agent: AutomationAgent): string {
  const { tools } = agent;
  const commands = tools.allowed_commands.length;
  const may = [
    tools.read_files && "read files",
    tools.edit_files && "edit files",
    tools.run_commands &&
      (commands === 0
        ? "run any command"
        : `run ${commands} ${commands === 1 ? "command" : "commands"}`),
    tools.use_web && "use the web",
  ].filter((item) => typeof item === "string");
  const harness = HARNESS_NAMES[agent.harness];
  return may.length === 0
    ? `${harness}. Can only use the ticketd command line.`
    : `${harness}. Can ${LIST.format(may)}, and use the ticketd command line.`;
}

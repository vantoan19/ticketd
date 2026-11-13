import {
  HARNESS_NAMES,
  type AutomationAgent,
  type AutomationCondition,
} from "@/features/automations/client";
import { providerName } from "@/features/tickets/ticket-source";
import type { Project } from "@/lib/api/client";

const LIST = new Intl.ListFormat("en", { type: "conjunction" });
export const OR = new Intl.ListFormat("en", { type: "disjunction" });

/** The source of a ticket no external tracker owns, as a condition stores it. */
const LOCAL_SOURCE = "local";
/** The sources a condition can name. */
// ponytail: GitHub is the only connector; list the configured providers when
// there is a second one.
export const CONDITION_SOURCES = ["github", LOCAL_SOURCE];

export function sourceName(source: string): string {
  return source === LOCAL_SOURCE ? "Local" : providerName(source);
}

export function projectName(id: string, projects: Project[]): string {
  return (
    projects.find((project) => project.id === id)?.name ?? "a deleted project"
  );
}

/**
 * The conditions as the line on the trigger's card ("Only in web-app, with
 * bug"); nothing when no condition has a value yet.
 */
export function conditionsLine(
  conditions: AutomationCondition[],
  projects: Project[],
): string | undefined {
  const parts = conditions.flatMap((condition) => {
    if (condition.kind === "tag")
      return condition.tag.trim()
        ? [`${condition.has ? "with" : "without"} ${condition.tag.trim()}`]
        : [];
    if (condition.any_of.length === 0) return [];
    if (condition.kind === "project")
      return [
        `in ${OR.format(condition.any_of.map((id) => projectName(id, projects)))}`,
      ];
    return [
      OR.format(
        condition.any_of.map((source) =>
          source === LOCAL_SOURCE
            ? "local tickets"
            : `from ${providerName(source)}`,
        ),
      ),
    ];
  });
  return parts.length > 0 ? `Only ${parts.join(", ")}` : undefined;
}

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

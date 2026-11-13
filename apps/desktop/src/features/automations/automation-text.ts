import {
  HARNESS_NAMES,
  type AutomationAgent,
} from "@/features/automations/client";

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * The ticket fields a step's text can refer to, by the name a person reads. The
 * text stores each as `{{reference}}`; the core fills them in when the step runs.
 */
export const TEXT_FIELDS = {
  "ticket.reference": "Ticket reference",
  "ticket.title": "Ticket title",
  "ticket.status": "Ticket status",
  "event.tag": "Tag from the event",
} as const;
export type TextField = keyof typeof TEXT_FIELDS;

const REFERENCE =
  /\{\{(ticket\.reference|ticket\.title|ticket\.status|event\.tag)\}\}/;

/** Stored text as the pieces a person sees: what was typed, and each field. */
export function textParts(text: string): (string | { field: TextField })[] {
  // A capturing split puts each reference's name at the odd places.
  return text
    .split(REFERENCE)
    .map((part, index) =>
      index % 2 === 1 ? { field: part as TextField } : part,
    )
    .filter((part) => part !== "");
}

/** Stored text in words on one line, each field by its name: for a card. */
export function textInWords(text: string): string {
  return textParts(text)
    .map((part) =>
      typeof part === "string" ? part : ` ${TEXT_FIELDS[part.field]} `,
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
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

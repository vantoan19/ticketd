import {
  HARNESS_NAMES,
  WEEKDAYS,
  type AutomationAgent,
  type AutomationCondition,
  type AutomationSchedule,
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

const DAY_NAMES: Record<
  (typeof WEEKDAYS)[number],
  { short: string; long: string }
> = {
  mon: { short: "Mon", long: "Monday" },
  tue: { short: "Tue", long: "Tuesday" },
  wed: { short: "Wed", long: "Wednesday" },
  thu: { short: "Thu", long: "Thursday" },
  fri: { short: "Fri", long: "Friday" },
  sat: { short: "Sat", long: "Saturday" },
  sun: { short: "Sun", long: "Sunday" },
};
export const dayName = (day: (typeof WEEKDAYS)[number]) => DAY_NAMES[day].long;

/** Whether this computer shows times on the 12-hour clock, as its time fields do. */
const systemHour12 = () =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()
    .hour12 ?? false;

/**
 * A schedule in words ("Mondays at 9:00", "Every 6 hours"), or what it still
 * needs. Times are stored on the 24-hour clock and read on the computer's
 * (`hour12`), so a card agrees with the time field that sets it.
 */
export function scheduleText(
  schedule: AutomationSchedule,
  hour12 = systemHour12(),
): string {
  if (schedule.kind === "every_hours")
    return schedule.hours < 1
      ? "Choose how often"
      : schedule.hours === 1
        ? "Every hour"
        : `Every ${schedule.hours} hours`;
  const days = WEEKDAYS.filter((day) => schedule.weekdays.includes(day));
  const [hour, minute] = schedule.time.split(":");
  if (days.length === 0) return "Choose days";
  if (!hour || !minute) return "Choose a time";
  const on =
    days.length === 7
      ? "Every day"
      : days.join() === "mon,tue,wed,thu,fri"
        ? "Weekdays"
        : days.length === 1 && days[0]
          ? `${DAY_NAMES[days[0]].long}s`
          : LIST.format(days.map((day) => DAY_NAMES[day].short));
  const at = hour12
    ? `${Number(hour) % 12 || 12}:${minute} ${Number(hour) < 12 ? "AM" : "PM"}`
    : `${Number(hour)}:${minute}`;
  return `${on} at ${at}`;
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

type Tools = AutomationAgent["tools"];

/**
 * The switches Codex does not follow. It reads files and runs any command inside
 * its own sandbox, and that sandbox always lets it write in the step's folder, so
 * with Codex these are on whatever is stored. The agent keeps its own choices
 * for Claude Code.
 */
export const FIXED_ON_FOR_CODEX: ReadonlySet<keyof Tools> = new Set([
  "read_files",
  "edit_files",
  "run_commands",
]);

/** What an agent may do, in a sentence: its reach, shown where it is used. */
export function agentReach(agent: AutomationAgent): string {
  const tools: Tools =
    agent.harness === "codex"
      ? // FIXED_ON_FOR_CODEX, and its commands are not limited to a list.
        {
          ...agent.tools,
          read_files: true,
          edit_files: true,
          run_commands: true,
          any_command: true,
        }
      : agent.tools;
  const commands = tools.allowed_commands.length;
  const may = [
    tools.read_files && "read files",
    tools.edit_files && "edit files",
    // "Any command" is said outright; an empty list allows none.
    tools.run_commands &&
      (tools.any_command
        ? "run any command"
        : commands > 0 &&
          `run ${commands} ${commands === 1 ? "command" : "commands"}`),
    tools.use_web && "use the web",
  ].filter((item) => typeof item === "string");
  const harness = HARNESS_NAMES[agent.harness];
  return may.length === 0
    ? `${harness}. Can only use the ticketd command line.`
    : `${harness}. Can ${LIST.format(may)}, and use the ticketd command line.`;
}

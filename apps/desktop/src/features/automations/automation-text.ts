import type { HarnessInfo } from "@/features/chats/client";
import {
  WEEKDAYS,
  type AutomationAgent,
  type AutomationCondition,
  type AutomationSchedule,
} from "@/features/automations/client";
import { providerName, type SourceEntry } from "@/lib/api/sources";
import type { Project } from "@/lib/api/client";

const LIST = new Intl.ListFormat("en", { type: "conjunction" });
export const OR = new Intl.ListFormat("en", { type: "disjunction" });

export const LOCAL_SOURCE = "local";

export function sourceName(
  source: string,
  sources: readonly SourceEntry[],
): string {
  return source === LOCAL_SOURCE ? "Local" : providerName(source, sources);
}

export function projectName(id: string, projects: Project[]): string {
  const project = projects.find((project) => project.id === id);
  if (!project) return "a deleted project";
  return project.archived ? `${project.name} (archived)` : project.name;
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
  sources: readonly SourceEntry[] = [],
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
            : `from ${providerName(source, sources)}`,
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

/** A field as a card marks it: short, since the card already says "Ticket". */
const FIELD_MARKS: Record<TextField, string> = {
  "ticket.reference": "[reference]",
  "ticket.title": "[title]",
  "ticket.status": "[status]",
  "event.tag": "[tag]",
};

/**
 * Stored text on one line, each field marked as one ("Ticket [reference]
 * changed"), so a field never reads as words of the message: for a card.
 */
export function textInWords(text: string): string {
  return textParts(text)
    .map((part) => (typeof part === "string" ? part : FIELD_MARKS[part.field]))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** The last part of a path: the folder's own name. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** What an agent may do, in a sentence: its reach, shown where it is used. */
export function agentReach(
  agent: AutomationAgent,
  harness: HarnessInfo | undefined,
): string {
  if (!harness?.unattended) return harness?.name ?? agent.harness;
  const tools = agent.tools;
  const reach = harness.unattended;
  const commands = tools.allowed_commands.length;
  const may = [
    (reach.reads === "requires_commands"
      ? tools.run_commands
      : tools.read_files || tools.edit_files) && "read files",
    tools.edit_files && "edit files",
    tools.run_commands &&
      (reach.commands === "off_or_any" || tools.any_command
        ? "run any command"
        : commands > 0 &&
          `run ${commands} ${commands === 1 ? "command" : "commands"}`),
    tools.use_web && "use the web",
  ].filter((item) => typeof item === "string");
  return may.length === 0
    ? `${harness.name}. Can only use the ticketd command line.`
    : `${harness.name}. Can ${LIST.format(may)}, and use the ticketd command line.`;
}

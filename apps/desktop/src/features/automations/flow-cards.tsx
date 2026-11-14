import type { ReactNode } from "react";
import {
  Bell,
  Bot,
  CalendarClock,
  Play,
  Split,
  SquarePen,
  Tag,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  folderName,
  projectName,
  scheduleText,
  textInWords,
} from "@/features/automations/automation-text";
import { TRIGGER_ID } from "@/features/automations/canvas-layout";
import {
  HARNESS_NAMES,
  type AutomationAgent,
  type AutomationCheck,
  type AutomationDefinition,
  type AutomationStep,
  type AutomationTrigger,
} from "@/features/automations/client";
import type { Project } from "@/lib/api/client";

/* What the cards of a flow say, for the editor and for a run alike. */

export const TRIGGER_KINDS: Record<AutomationTrigger["kind"], string> = {
  ticket_created: "When a ticket is created",
  ticket_updated: "When a ticket is updated",
  status_changed: "When the status changes",
  tag_added: "When a tag is added",
  tag_removed: "When a tag is removed",
  activity_created: "When an update is added",
  schedule: "On a schedule",
  by_hand: "By hand",
};
const STEP_KINDS: Record<AutomationStep["kind"], string> = {
  run_agent: "Run agent",
  change_ticket: "Change ticket",
  notify: "Notify me",
  if: "If",
};

export type Card = {
  id: string;
  /** The small line above: what kind of card this is. */
  kind: string;
  /** What it does, in words; with `kind`, its accessible name. */
  title: string;
  /** The title as shown, when it is more than the words. */
  shown?: ReactNode;
  detail?: string;
  icon:
    | "trigger"
    | "tag"
    | "schedule"
    | "hand"
    | "agent"
    | "change"
    | "notify"
    | "if";
  /** Nothing chosen yet: the card is a prompt. */
  unset: boolean;
  /** Which menu the card carries. */
  menu: "choose-trigger" | "change-trigger" | "step";
};

/** `only` is the line its conditions add (see `conditionsLine`). */
export function triggerCard(
  trigger: AutomationDefinition["trigger"],
  only?: string,
): Card {
  if (!trigger)
    return {
      id: TRIGGER_ID,
      kind: "Trigger",
      title: "Choose what starts it",
      icon: "trigger",
      unset: true,
      menu: "choose-trigger",
    };
  const kind = TRIGGER_KINDS[trigger.kind];
  const detail = only ? { detail: only } : {};
  if (trigger.kind === "status_changed") {
    const { to, from } = trigger;
    return {
      id: TRIGGER_ID,
      kind,
      title: !to
        ? "Choose a status"
        : from
          ? `From ${from} to ${to}`
          : `To ${to}`,
      ...detail,
      icon: "trigger",
      unset: !to,
      menu: "change-trigger",
    };
  }
  // Nothing narrows these two: a condition is about a ticket.
  if (trigger.kind === "schedule") {
    const { schedule } = trigger;
    return {
      id: TRIGGER_ID,
      kind,
      title: scheduleText(schedule),
      icon: "schedule",
      unset:
        schedule.kind === "every_hours"
          ? schedule.hours < 1
          : schedule.weekdays.length === 0 || !schedule.time,
      menu: "change-trigger",
    };
  }
  if (trigger.kind === "by_hand")
    return {
      id: TRIGGER_ID,
      kind,
      title: "When you run it",
      icon: "hand",
      unset: false,
      menu: "change-trigger",
    };
  if (trigger.kind !== "tag_added" && trigger.kind !== "tag_removed")
    return {
      id: TRIGGER_ID,
      kind: "Trigger",
      title: kind,
      ...detail,
      icon: "trigger",
      unset: false,
      menu: "change-trigger",
    };
  const tag = trigger.tag.trim();
  return {
    id: TRIGGER_ID,
    kind,
    ...detail,
    title: tag || "Choose a tag",
    ...(tag && {
      shown: (
        <Badge variant="tag" size="sm">
          {tag}
        </Badge>
      ),
    }),
    icon: "tag",
    unset: !tag,
    menu: "change-trigger",
  };
}

/** `projects` names the project an If checks for, where the list is at hand. */
export function stepCard(
  step: AutomationStep,
  agents: AutomationAgent[],
  projects?: Project[],
): Card {
  const kind = STEP_KINDS[step.kind];
  if (step.kind === "change_ticket") {
    const change = step.change;
    const title =
      change?.action === "add_tag"
        ? change.tag.trim() && `Add tag ${change.tag.trim()}`
        : change?.action === "remove_tag"
          ? change.tag.trim() && `Remove tag ${change.tag.trim()}`
          : change?.action === "set_status"
            ? `Set status to ${change.status}`
            : change?.action === "post_update"
              ? change.text.trim() && "Post an update"
              : "";
    const detail =
      change?.action === "post_update" ? textInWords(change.text) : "";
    return {
      id: step.id,
      kind,
      title: title || "Choose a change",
      ...(detail && { detail }),
      icon: "change",
      unset: !title,
      menu: "step",
    };
  }
  if (step.kind === "notify") {
    const message = textInWords(step.text);
    return {
      id: step.id,
      kind,
      title: message || "Write a message",
      detail: step.opens === "run" ? "Opens the run" : "Opens the ticket",
      icon: "notify",
      unset: !message,
      menu: "step",
    };
  }
  if (step.kind === "if") {
    const asked = ifTitle(step.checks, projects);
    return {
      id: step.id,
      kind,
      title: asked || "Choose what to check",
      icon: "if",
      unset: !asked,
      menu: "step",
    };
  }
  const agent = agents.find((item) => item.id === step.agent_id);
  const where = step.execution_folder
    ? `in ${folderName(step.execution_folder)}`
    : null;
  return {
    id: step.id,
    kind,
    title: agent ? agent.name.trim() || "New agent" : "Choose an agent",
    ...(agent && {
      detail: [HARNESS_NAMES[agent.harness], where].filter(Boolean).join(" · "),
    }),
    icon: "agent",
    unset: !agent,
    menu: "step",
  };
}

/**
 * One check in words: "has tag verified", "status is not Done". A tag check
 * with no tag yet says nothing.
 */
export function checkWords(
  check: AutomationCheck,
  projects?: Project[],
): string {
  if (check.kind === "tag")
    return check.tag.trim()
      ? `${check.has ? "has" : "does not have"} tag ${check.tag.trim()}`
      : "";
  if (check.kind === "status")
    return `status ${check.is ? "is" : "is not"} ${check.status}`;
  if (check.project_id === null)
    return check.is ? "has no project" : "has a project";
  // A run shows the Automation as it was, without the list of projects.
  const name = projects
    ? projectName(check.project_id, projects)
    : "the one chosen";
  return `project ${check.is ? "is" : "is not"} ${name}`;
}

/** What an If asks of the ticket, in words; nothing until a check says something. */
function ifTitle(checks: AutomationCheck[], projects?: Project[]): string {
  const words = checks
    .map((check) => checkWords(check, projects))
    .filter(Boolean);
  return words.length > 0 ? `Ticket ${words.join(" and ")}` : "";
}

/** What each line that is not simply the next step says. */
export const PATH_LABELS = { yes: "Yes", no: "No", failure: "If it fails" };
/** The pill a path's label sits in, for React Flow's edge label. */
export const PATH_LABEL_SHAPE = {
  labelBgPadding: [6, 3] as [number, number],
  labelBgBorderRadius: 4,
};

export const cardName = (card: Card) => `${card.kind}: ${card.title}`;
/** Moves focus to a card on the canvas, as when its panel closes. */
export function focusCard(id: string) {
  for (const card of document.querySelectorAll<HTMLElement>("[data-flow-card]"))
    if (card.dataset.flowCard === id) card.focus();
}
/** The kind a card is colored by: every trigger alike, each step by its own. */
export const cardColor = (card: Card) =>
  card.menu === "step" ? card.icon : "trigger";
/** The icon a card leads with. */
export const CARD_ICONS = {
  trigger: Zap,
  schedule: CalendarClock,
  hand: Play,
  tag: Tag,
  agent: Bot,
  change: SquarePen,
  notify: Bell,
  if: Split,
};

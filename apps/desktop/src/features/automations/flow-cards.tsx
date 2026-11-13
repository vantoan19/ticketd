import type { ReactNode } from "react";
import { Bell, Bot, SquarePen, Tag, Workflow, Zap } from "lucide-react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import {
  folderName,
  textInWords,
} from "@/features/automations/automation-text";
import { TRIGGER_ID } from "@/features/automations/canvas-layout";
import {
  HARNESS_NAMES,
  type AutomationAgent,
  type AutomationDefinition,
  type AutomationStep,
  type AutomationTrigger,
} from "@/features/automations/client";

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
  icon: "trigger" | "tag" | "agent" | "change" | "notify" | "step";
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

export function stepCard(
  step: AutomationStep,
  agents: AutomationAgent[],
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
  if (step.kind !== "run_agent")
    return {
      id: step.id,
      kind,
      title: "Set up in a later version",
      icon: "step",
      unset: false,
      menu: "step",
    };
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

const checksSchema = z.array(
  z.union([
    z.object({ kind: z.literal("tag"), tag: z.string(), has: z.boolean() }),
    z.object({
      kind: z.literal("status"),
      status: z.string(),
      is: z.boolean(),
    }),
    z.object({ kind: z.literal("project"), is: z.boolean() }),
  ]),
);
/** What an If asks of the ticket, in words. */
// ponytail: plain words from the stored checks; the If step's own card replaces
// this when the editor can set one up.
function ifTitle(step: AutomationStep): string {
  const checks = checksSchema.safeParse(step.checks).data ?? [];
  const words = checks.map((check) =>
    check.kind === "tag"
      ? `${check.has ? "has" : "does not have"} tag ${check.tag}`
      : check.kind === "status"
        ? `status ${check.is ? "is" : "is not"} ${check.status.replaceAll("_", " ")}`
        : `project ${check.is ? "is" : "is not"} the one chosen`,
  );
  return words.length > 0 ? `Ticket ${words.join(" and ")}` : "No checks";
}

/** The card of a step as a run shows it: a step of any kind the record holds. */
export function runCard(step: AutomationStep, agents: AutomationAgent[]): Card {
  const card = stepCard(step, agents);
  return step.kind === "if" ? { ...card, title: ifTitle(step) } : card;
}

export const cardName = (card: Card) => `${card.kind}: ${card.title}`;
/** The icon a card leads with. */
export const CARD_ICONS = {
  trigger: Zap,
  tag: Tag,
  agent: Bot,
  change: SquarePen,
  notify: Bell,
  step: Workflow,
};

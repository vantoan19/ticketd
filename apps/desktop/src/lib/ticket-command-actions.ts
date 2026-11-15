import type { ShortcutId } from "@/lib/shortcuts";

/** One vocabulary for the palette, direct keys, property hints and Settings. */
export const ticketCommandActions = [
  { scope: "Status", label: "Change status…", shortcut: "ticket-status" },
  { scope: "Plan", label: "Move to Plan…", shortcut: "ticket-plan" },
  { scope: "Project", label: "Change project…", shortcut: "ticket-project" },
  { scope: "Tags", label: "Edit tags…", shortcut: "ticket-tags" },
  { scope: "Reminder", label: "Remind me…", shortcut: "ticket-reminder" },
] as const satisfies readonly {
  scope: string;
  label: string;
  shortcut: ShortcutId;
}[];
export type TicketCommandScope = (typeof ticketCommandActions)[number]["scope"];

import { plural } from "@/lib/format";

/*
 * The one registry of empty-state words (DESIGN.md section 12, proposal P9),
 * kept together so they are reviewed together. Rules: "No {plural} yet",
 * "{Place} is empty", "No {things} match …"; never "scope", "eligible" or
 * "snapshot"; one sentence saying what appears here and how it gets here.
 * `action` is the label of the one action that fills the view, when the
 * header does not already hold it.
 *
 * Placeholders: {query}, {name} (a Plan, project or view), {filters} ("3
 * filters"), filled by `emptyCopy`.
 */
const COPY = {
  "workspace-first-run": {
    title: "Your workspace is ready",
    sentence:
      "Tickets you and your agents create appear here. Everything stays on this computer unless you choose to sync it.",
    action: "New ticket",
  },
  "tickets-first-run": {
    title: "No tickets yet",
    sentence: "Tickets you create or import appear here.",
    action: "New ticket",
  },
  "tickets-ready": {
    title: "No Ready tickets",
    sentence: "Todo tickets appear here once nothing blocks them.",
  },
  "tickets-progress": {
    title: "Nothing in progress",
    sentence: "Move a ticket to In progress when work starts.",
  },
  "tickets-no-project": {
    title: "No tickets without a project",
    sentence: "Every ticket belongs to a project.",
  },
  "tickets-project": {
    title: "No tickets in {name}",
    sentence: "Tickets you create in this project appear here.",
    action: "New ticket",
  },
  "tickets-trash": {
    title: "Trash is empty",
    sentence: "Tickets you move to Trash wait here.",
  },
  "tickets-search": {
    title: "No tickets match “{query}”",
    sentence: "Searched titles, descriptions and updates in {name}.",
  },
  "tickets-search-filtered": {
    title: "No tickets match “{query}”",
    sentence:
      "Searched titles, descriptions and updates in {name}, with {filters} on.",
  },
  "tickets-filters": {
    title: "No tickets match these filters",
    sentence: "Nothing in {name} matches the {filters} on.",
  },
  "tickets-failed": {
    title: "Couldn't load tickets",
    sentence: "Nothing changed. Retry to read the list again.",
    action: "Retry",
  },
  "plan-empty": {
    title: "No tickets in {name}",
    sentence: "Add existing tickets or create one.",
    action: "Add to Plan…",
  },
  "plan-archived": {
    title: "No tickets in this Plan",
    sentence: "Reactivate the Plan to add tickets.",
  },
  "board-column": { title: "No tickets", sentence: "" },
  "board-column-filtered": { title: "No matches", sentence: "" },
  "inbox-caught-up": {
    title: "You're all caught up",
    sentence:
      "Approvals, reviews and reminders land here first, then updates from your agents on tickets you follow.",
    action: "Show read entries",
  },
  plans: {
    title: "No Plans yet",
    sentence: "A Plan groups the tickets that ship together.",
  },
  "plans-archived": {
    title: "No archived Plans",
    sentence: "Plans you archive wait here.",
  },
  projects: {
    title: "No projects yet",
    sentence: "A project is a repository on this computer.",
    action: "New project",
  },
  "documents-recent": {
    title: "No recently opened Documents",
    sentence: "Documents you open appear here.",
  },
  "documents-all": {
    title: "No Documents yet",
    sentence: "Capture a thought to start a Document.",
  },
  "documents-trash": {
    title: "Trash is empty",
    sentence: "Documents you move to Trash wait here.",
  },
  attachments: {
    title: "No attachments yet",
    sentence: "Files you attach to tickets and Documents appear here.",
  },
  "attachments-search": {
    title: "No attachments match “{query}”",
    sentence: "Searched names and metadata in {name}.",
    action: "Clear search",
  },
  "attachments-in-use": {
    title: "No files in use",
    sentence: "Files a ticket or Document links to appear here.",
    action: "Show all files",
  },
  "attachments-unused": {
    title: "No unused files",
    sentence: "Files no ticket or Document links to appear here.",
    action: "Show all files",
  },
  "attachments-quarantine": {
    title: "Quarantine is empty",
    sentence:
      "Files you clean up wait here until you restore them or delete them permanently.",
    action: "Show all files",
  },
  "attachments-select": {
    title: "Select a file to preview it",
    sentence: "",
  },
  "workspace-graph": {
    title: "Nothing connected yet",
    sentence:
      "Tickets, Documents and Plans appear here once they link to each other.",
    action: "Open All tickets",
  },
  chats: {
    title: "No Chats yet",
    sentence: "A Chat runs an agent on your tickets and code.",
    action: "New Chat",
  },
  "chats-trash": {
    title: "Trash is empty",
    sentence: "Chats you move to Trash wait here.",
  },
  "chats-archived": {
    title: "Archived Chats wait here until you unarchive them.",
    sentence: "",
  },
  automations: {
    title: "No Automations yet",
    sentence: "An Automation runs steps on your tickets for you.",
  },
  agents: {
    title: "No agents yet",
    sentence:
      "An agent supplies the instructions and tools for an Automation step.",
  },
  "automation-runs": {
    title: "No runs yet",
    sentence: "Run an Automation to see its progress and history here.",
  },
  "settings-search": {
    title: "No settings match “{query}”",
    sentence: "Try another word, or open a section below.",
  },
  "settings-shortcuts-search": {
    title: "No shortcuts match “{query}”",
    sentence: "Try a key's name, such as Enter or Escape.",
  },
  "diagnostics-errors": {
    title: "No recent errors",
    sentence: "Warnings and errors ticketd logs appear here.",
  },
  cleanup: {
    title: "No unused files",
    sentence: "Files no ticket or Document uses show up here.",
  },
} satisfies Record<string, EmptyCopy>;

export type EmptyCopy = { title: string; sentence: string; action?: string };
export type EmptyView = keyof typeof COPY;

/** The words for an empty view, with its placeholders filled. */
export function emptyCopy(
  view: EmptyView,
  values: { query?: string; name?: string; filters?: number } = {},
): EmptyCopy {
  const copy: EmptyCopy = COPY[view];
  const fill = (text: string) =>
    text
      .replaceAll("{query}", values.query ?? "")
      .replaceAll("{name}", values.name ?? "")
      .replaceAll("{filters}", plural(values.filters ?? 0, "filter"));
  return {
    title: fill(copy.title),
    sentence: fill(copy.sentence),
    ...(copy.action && { action: copy.action }),
  };
}

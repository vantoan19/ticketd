import type { SettingsPageId } from "@/features/settings/settings-sections";

/** One setting row, as Search finds it. */
export interface SettingsEntry {
  title: string;
  description: string;
  /** Related words people might type instead of the title. */
  keywords?: string;
  /** The page that holds the setting. */
  section: SettingsPageId;
}

/**
 * Every setting row on the pages with a fixed place in `SETTINGS_SECTIONS`,
 * described by the title and description its page shows. Add an entry when a
 * page gains a row; `settings-search.test.ts` keeps each one pointing at a
 * real section. Sources add theirs through `sourceEntries`.
 */
export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  {
    title: "Theme",
    description:
      "System follows your operating system. Light and Dark override it.",
    keywords: "dark mode light colour color appearance system",
    section: "appearance",
  },
  {
    title: "Open tickets",
    description:
      "Beside the list or full width. Applies to the next ticket you open from a list.",
    keywords: "split layout expanded view full width pane",
    section: "appearance",
  },
  {
    title: "Follow tickets I create",
    description: "Tickets you create in ticketd become followed tickets.",
    keywords: "follow following inbox",
    section: "attention",
  },
  {
    title: "Notify me when a reminder is due",
    description:
      "Shows a system notification while ticketd is open. Reminders that come due while it is closed appear only in the inbox.",
    keywords: "notification notifications reminder alert permission",
    section: "attention",
  },
  {
    title: "Attention inbox",
    description:
      "Followed tickets and due reminders collect here. Follows and reminders belong to the person on this computer.",
    keywords: "inbox follows reminders open",
    section: "attention",
  },
  {
    title: "Workspace file",
    description:
      "The file the desktop app and the command line read and write.",
    keywords: "path folder sqlite database finder show copy location",
    section: "location",
  },
  {
    title: "One file, two ways in",
    description:
      "Changes made by you in the app and by agents through the command line land in the same file.",
    keywords: "desktop app command line agents reads writes",
    section: "location",
  },
  {
    title: "Contents",
    description:
      "Tickets, Documents, Projects, Active Plans, file size and format version.",
    keywords: "size tickets documents projects plans format version count",
    section: "location",
  },
  {
    title: "Upload destination",
    description:
      "Local uploads are included in backups; Drive uploads stay in Drive.",
    keywords: "files drive local storage uploads attachments",
    section: "attachments",
  },
  {
    title: "Upload folder",
    description:
      "The Drive folder new uploads go to. Writable when selected; checked again before each upload.",
    keywords: "drive change folder",
    section: "attachments",
  },
  {
    title: "Largest file",
    description: "Per file, for future uploads. Default: 100 MiB.",
    keywords: "upload limit size mib maximum default",
    section: "attachments",
  },
  {
    title: "Back up now",
    description:
      "A complete copy of the workspace, checked for integrity after it is saved.",
    keywords: "backup copy save last backup",
    section: "backups",
  },
  {
    title: "What a backup contains",
    description:
      "The whole workspace, local attachment files and an integrity check. Files in Google Drive are kept as references.",
    keywords: "includes contents attachments integrity",
    section: "backups",
  },
  {
    title: "Restore from a backup",
    description: "Review what the backup contains before anything changes.",
    keywords: "restore recover replace workspace choose backup",
    section: "backups",
  },
  {
    title: "Safety backups",
    description:
      "Kept automatically before a restore or a format upgrade, so a restore can be undone.",
    keywords: "undo backup automatic",
    section: "backups",
  },
  {
    title: "Export as JSON",
    description:
      "One readable snapshot of the workspace, including Trash. It cannot be imported back.",
    keywords: "json snapshot download trash",
    section: "export",
  },
  {
    title: "Export from the command line",
    description:
      "The same export, or a ticket or Document as Markdown, with ticketd export and export-markdown.",
    keywords: "markdown cli terminal manifest folder",
    section: "export",
  },
  {
    title: "Export or back up?",
    description:
      "Compares what each is meant for, its format, whether it includes Trash and whether it can be restored.",
    keywords: "difference compare restore",
    section: "export",
  },
  {
    title: "Status",
    description:
      "Whether the ticketd executable is found on your PATH, with its version and workspace.",
    keywords:
      "command-line tool path terminal install cli check again executable",
    section: "command-line",
  },
  {
    title: "Quick reference for agents",
    description: "Commands agents use most, ready to copy.",
    keywords: "commands examples copy cli",
    section: "command-line",
  },
  {
    title: "ticketd skill",
    description:
      "Teaches Claude Code and Codex to use the ticketd command line.",
    keywords: "claude code codex agent install update skill",
    section: "agent-skills",
  },
  {
    title: "Agents on this computer",
    description:
      "ticketd installs only for agents it finds. An edited copy is left alone until you choose Replace.",
    keywords: "claude codex detected replace check again",
    section: "agent-skills",
  },
  {
    title: "Show Chat",
    description:
      "Adds Chats and Automations to the sidebar, where you start and follow your agents’ work.",
    keywords:
      "chat claude codex ai experimental sidebar conversations automations",
    section: "chat",
  },
  {
    title: "Runs at once",
    description:
      "Runs beyond this wait in a queue, in the order their events happened.",
    keywords: "automation automations concurrency parallel limit queue agents",
    section: "automations",
  },
  {
    title: "Start ticketd when you sign in",
    description: "Automations run only while ticketd is running.",
    keywords:
      "automation automations login startup autostart launch background tray boot",
    section: "automations",
  },
  {
    title: "Google Drive",
    description:
      "Keep this workspace in sync between your desktops through a folder in your own Google Drive.",
    keywords: "sync cloud connect account desktops folder",
    section: "google-drive",
  },
  {
    title: "Name",
    description:
      "Names this desktop in Drive. Its ticket code numbers the tickets created here.",
    keywords: "this desktop device ticket code",
    section: "google-drive",
  },
  {
    title: "Check for changes every",
    description:
      "How often this desktop checks Drive. Your own changes upload right after each save.",
    keywords: "check interval seconds poll sync frequency options",
    section: "google-drive",
  },
  {
    title: "Attachments",
    description: "Download every file automatically, or only when you open it.",
    keywords: "download automatically when opened offline disk space files",
    section: "google-drive",
  },
  {
    title: "Disconnect this desktop",
    description: "Stops syncing this workspace through Drive.",
    keywords: "disconnect google drive sign out account remove unlink",
    section: "google-drive",
  },
  {
    title: "Lists",
    description:
      "Move between tickets, open the focused ticket and resize the list from the divider.",
    keywords: "keyboard shortcuts keys hotkeys arrows enter divider resize",
    section: "keyboard-shortcuts",
  },
  {
    title: "Creating",
    description:
      "Create from the New ticket dialog, and capture a thought from anywhere.",
    keywords: "keyboard shortcuts keys hotkeys new ticket capture",
    section: "keyboard-shortcuts",
  },
  {
    title: "Dialogs and menus",
    description: "Close the top surface without throwing away a draft.",
    keywords: "keyboard shortcuts keys hotkeys escape esc close",
    section: "keyboard-shortcuts",
  },
  {
    title: "Documentation",
    description: "Guides for the desktop app and the command line.",
    keywords: "about version help docs guides",
    section: "about",
  },
  {
    title: "Report an issue",
    description:
      "Opens the issue tracker in your browser. Include the version above.",
    keywords: "about version bug feedback tracker help",
    section: "about",
  },
  {
    title: "Privacy",
    description:
      "What stays on this computer, and what each integration sends.",
    keywords: "analytics offline account data",
    section: "about",
  },
  {
    title: "Third-party notices",
    description: "Licenses for the libraries and fonts ticketd ships with.",
    keywords: "licenses open source libraries fonts",
    section: "about",
  },
];

/** The rows every source page has, for a source the build offers. */
export function sourceEntries(provider: string, name: string): SettingsEntry[] {
  const section: SettingsPageId = `source-${provider}`;
  return [
    {
      title: `${name} connection`,
      description: `Uses your own ${name} permissions. Check that ticketd is connected.`,
      keywords: `account sign in token permissions ${provider}`,
      section,
    },
    {
      title: "Discovery",
      description: `Which ${name} issues are imported into this workspace.`,
      keywords: `rules repositories labels assignee import issues preview save ${provider}`,
      section,
    },
    {
      title: "Sync",
      description: `When ${name} issues refresh, and how agents can refresh without the desktop open.`,
      keywords: `refresh schedule source refresh command ${provider}`,
      section,
    },
  ];
}

function contains(text: string | undefined, query: string) {
  return text !== undefined && text.toLowerCase().includes(query);
}

/**
 * The entries that match `query`, best first: title matches, then description,
 * then keywords and the page name. Equal ranks keep registry order. An empty
 * query matches nothing.
 */
export function searchSettings<T extends SettingsEntry>(
  query: string,
  entries: readonly T[],
  pageName?: (entry: T) => string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const ranked: { entry: T; rank: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const rank = contains(entry.title, needle)
      ? 0
      : contains(entry.description, needle)
        ? 1
        : contains(entry.keywords, needle) ||
            contains(pageName?.(entry), needle)
          ? 2
          : -1;
    if (rank >= 0) ranked.push({ entry, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map(({ entry }) => entry);
}

/** `text` cut around the first match of `query`: [before, match, after]. */
export function splitMatch(
  text: string,
  query: string,
): [string, string, string] {
  const needle = query.trim().toLowerCase();
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return [text, "", ""];
  return [
    text.slice(0, at),
    text.slice(at, at + needle.length),
    text.slice(at + needle.length),
  ];
}

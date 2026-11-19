import type { SettingsPageId } from "@/features/settings/settings-sections";

/** One setting row, as Search finds it. */
export interface SettingsEntry {
  title: string;
  description: string;
  /** Related words people might type instead of the title. */
  keywords?: string;
  /** The page that holds the setting. */
  section: SettingsPageId;
  /** The row is on its page only while Chat is on. */
  needsChat?: true;
}

/**
 * Every setting row on the pages with a fixed place in `SETTINGS_SECTIONS`,
 * described by the title and description its page shows. Add an entry when a
 * page gains a row; `settings-search.test.ts` keeps each one pointing at a
 * real section and `settings-copy.test.tsx` mounts the pages to check that the
 * title and description are still on them, word for word. Sources add theirs
 * through `sourceEntries`.
 */
export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  {
    title: "Theme",
    description: "System follows your operating system",
    keywords: "dark mode light colour color appearance system",
    section: "appearance",
  },
  {
    title: "Open tickets",
    description: "Applies the next time you open a ticket from a list.",
    keywords: "split layout expanded view beside the list full width pane",
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
      "The desktop app and the ticketd command line read and write this workspace.",
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
    description: "Format version",
    keywords: "size tickets documents projects plans format version count",
    section: "location",
  },
  {
    title: "Upload destination",
    description:
      "Applies to new uploads only. Queued uploads and retries keep their original destination.",
    keywords:
      "files drive local storage uploads attachments on this computer included in backups",
    section: "attachments",
  },
  {
    title: "Upload folder",
    description: "Writable when selected. Checked again before each upload.",
    keywords: "drive change folder",
    section: "attachments",
  },
  {
    title: "Upload limit",
    description: "Per file, for future uploads. All file types are accepted.",
    keywords: "largest file size mib maximum default",
    section: "attachments",
  },
  {
    title: "Back up now",
    description:
      "Saves a checked copy to a new file you choose. It never replaces an existing file.",
    keywords: "backup copy save last backup",
    section: "backups",
  },
  {
    title: "What a backup contains",
    description: "Tickets, Documents, Plans, Projects, activity and evidence",
    keywords:
      "includes contents local attachment files integrity check google drive not included",
    section: "backups",
  },
  {
    title: "Restore from a backup",
    description:
      "Replaces this workspace after a review. A safety backup of it is saved first.",
    keywords: "restore recover replace workspace choose backup",
    section: "backups",
  },
  {
    title: "Safety backups",
    description:
      "Saved next to the workspace before a restore or a format upgrade, with every retained local attachment file. Restore one to undo.",
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
    title: "A ticket or Document as Markdown",
    description:
      "Portable Markdown with its referenced files and a manifest, written to a new ticketd-export folder.",
    keywords:
      "export command line cli terminal export-markdown same export json manifest folder",
    section: "export",
  },
  {
    title: "Export or back up?",
    description:
      "Readable copies of your work for other tools. To keep a copy you can restore, use Backups.",
    keywords: "difference compare restore",
    section: "export",
  },
  {
    title: "Status",
    description:
      "The ticketd executable that you, your scripts and your coding agents call.",
    keywords:
      "command-line tool path terminal install cli check again executable",
    section: "command-line",
  },
  {
    title: "Quick reference for agents",
    description:
      "Copy a command, then replace the words in color with your own values.",
    keywords: "commands examples copy cli",
    section: "command-line",
  },
  {
    title: "ticketd skill",
    description: "Teaches your coding agents to use the ticketd command line.",
    keywords: "claude code codex agent install update skill",
    section: "agent-skills",
  },
  {
    title: "Agents on this computer",
    description:
      "ticketd installs only for agents it finds. A copy that was edited or not written by ticketd is left alone until you choose Replace.",
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
    title: "Experimental",
    description:
      "Work with Claude Code or Codex from ticketd, using the copy installed on this computer.",
    keywords:
      "beta preview not yet qualified against real subscriptions claude codex ai",
    section: "chat",
  },
  {
    title: "Harnesses",
    description:
      "Chat runs the copy of Claude Code or Codex installed on this computer, signed in as you.",
    keywords:
      "harness claude code codex installed detected signed in check again copy command",
    section: "chat",
    needsChat: true,
  },
  {
    title: "Notify me about Chats",
    description: "Approvals, questions, failures and finished turns.",
    keywords: "chat notification notifications alert sound badge dock mute",
    section: "chat",
    needsChat: true,
  },
  {
    title: "Experimental",
    description:
      "Run agents and steps on tickets without starting each one by hand. Open Automations from the sidebar to set them up.",
    keywords: "automation automations beta preview agents steps",
    section: "automations",
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
    description: "New tickets here are numbered",
    keywords: "this desktop device ticket code",
    section: "google-drive",
  },
  {
    title: "Check for changes every",
    description: "Your own changes upload right after each save.",
    keywords: "check interval seconds poll sync frequency options",
    section: "google-drive",
  },
  {
    title: "Attachments",
    description: "Download when opened",
    keywords:
      "download automatically every file works offline saves disk space files",
    section: "google-drive",
  },
  {
    title: "Disconnect this desktop",
    description:
      "Stops syncing here. Your files stay in Drive and on this computer.",
    keywords: "disconnect google drive sign out account remove unlink",
    section: "google-drive",
  },
  {
    title: "Everywhere",
    description: "These work wherever you are in ticketd.",
    keywords:
      "keyboard shortcuts keys hotkeys capture new chat add settings find",
    section: "keyboard-shortcuts",
  },
  {
    title: "Lists",
    description:
      "In ticket lists and boards, the Inbox, Attachments, Documents and the Workspace graph. A list is one stop for Tab.",
    keywords:
      "keyboard shortcuts keys hotkeys arrows enter space select home end divider resize",
    section: "keyboard-shortcuts",
  },
  {
    title: "Ticket",
    description: "On the open ticket.",
    keywords:
      "keyboard shortcuts keys hotkeys edit description new ticket create",
    section: "keyboard-shortcuts",
  },
  {
    title: "Chat",
    description: "In a Chat's message box and its requests.",
    keywords: "keyboard shortcuts keys hotkeys chat send queue stop model",
    section: "keyboard-shortcuts",
    needsChat: true,
  },
  {
    title: "Dialogs and menus",
    description: "In any dialog, menu or sheet.",
    keywords: "keyboard shortcuts keys hotkeys escape esc close",
    section: "keyboard-shortcuts",
  },
  {
    title: "Debug logging",
    description:
      "Records more detail until ticketd restarts. TICKETD_LOG overrides it.",
    keywords: "diagnostics log level verbose troubleshoot",
    section: "diagnostics",
  },
  {
    title: "Log files",
    description:
      "One file per day, and the oldest are removed automatically. Open the logs folder.",
    keywords: "diagnostics logs folder open finder",
    section: "diagnostics",
  },
  {
    title: "Export diagnostics",
    description:
      "A small .zip of redacted logs and Workspace health to attach to a bug report.",
    keywords: "diagnostics bug report issue support summary copy zip logs",
    section: "diagnostics",
  },
  {
    title: "Recent errors",
    description:
      "The last kinds of warning and error ticketd logged, from the files still kept.",
    keywords: "diagnostics crash failure warning unexpected quit",
    section: "diagnostics",
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
      title: "Connection",
      description: `ticketd uses your own ${name} permissions.`,
      keywords: `${name} account sign in token permissions check connection ${provider}`,
      section,
    },
    {
      title: "Discovery",
      description: `Matching issues are imported as tickets on the next sync. Nothing is changed in ${name}.`,
      keywords: `${name} rules repositories labels assignee import issues preview save ${provider}`,
      section,
    },
    {
      title: "Sync",
      description: "Agents can sync without the desktop open",
      keywords: `${name} refresh schedule source refresh command sync now ${provider}`,
      section,
    },
  ];
}

/** Letters and digits of any alphabet; everything else separates words. */
const WORD = /[\p{L}\p{N}]+/gu;

function words(text: string | undefined): string[] {
  return text?.toLowerCase().match(WORD) ?? [];
}

/** Whether every query word starts some word of `text`: "back" finds "Back up", "board" does not find "Keyboard". */
function matchesWords(text: string | undefined, terms: readonly string[]) {
  const found = words(text);
  return terms.every((term) => found.some((word) => word.startsWith(term)));
}

/**
 * The entries that match `query`, best first: title matches, then description,
 * then keywords and the page name, then queries whose words are spread over
 * several of those. A query matches by word beginnings, never inside a word,
 * and every word of it must match. Equal ranks keep registry order. An empty
 * query matches nothing.
 */
export function searchSettings<T extends SettingsEntry>(
  query: string,
  entries: readonly T[],
  pageName?: (entry: T) => string,
): T[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  const ranked: { entry: T; rank: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const aside = `${entry.keywords ?? ""} ${pageName?.(entry) ?? ""}`;
    const rank = matchesWords(entry.title, terms)
      ? 0
      : matchesWords(entry.description, terms)
        ? 1
        : matchesWords(aside, terms)
          ? 2
          : matchesWords(`${entry.title} ${entry.description} ${aside}`, terms)
            ? 3
            : -1;
    if (rank >= 0) ranked.push({ entry, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map(({ entry }) => entry);
}

/** Whether the row, or the whole Automations page, exists only while Chat is on. */
const chatOnly = (entry: SettingsEntry) =>
  entry.section === "automations" || entry.needsChat === true;

/** Stands in for Chat-only rows while Chat is off: the Chat page is where it is turned on. */
const CHAT_PAGE_ENTRY: SettingsEntry = {
  title: "Chat",
  description:
    "Turn on Chat to set up harnesses, notifications and Automations.",
  section: "chat",
};

/**
 * `searchSettings` for the person's current Chat setting. While Chat is on every
 * entry is searched. While it is off the Chat-only rows stay hidden, but a query
 * that matches only them finds the Chat page entry instead, so the way to them
 * is not a dead end.
 */
export function searchSettingsFor<T extends SettingsEntry>(
  query: string,
  entries: readonly T[],
  chatEnabled: boolean,
  pageName?: (entry: T) => string,
): (T | SettingsEntry)[] {
  if (chatEnabled) return searchSettings(query, entries, pageName);
  const hits: (T | SettingsEntry)[] = searchSettings(
    query,
    entries.filter((entry) => !chatOnly(entry)),
    pageName,
  );
  if (hits.some((hit) => hit.section === "chat")) return hits;
  const hidden = searchSettings(query, entries.filter(chatOnly), pageName);
  return hidden.length > 0 ? [...hits, CHAT_PAGE_ENTRY] : hits;
}

/**
 * `text` cut around the first place `query` matches: [before, match, after].
 * Marks the whole query where it stands at a word start, else its first word
 * that does.
 */
export function splitMatch(
  text: string,
  query: string,
): [string, string, string] {
  const lower = text.toLowerCase();
  const startsWord = (at: number) =>
    at === 0 || !/[\p{L}\p{N}]/u.test(lower[at - 1] ?? "");
  const find = (needle: string) => {
    for (
      let at = lower.indexOf(needle);
      at >= 0;
      at = lower.indexOf(needle, at + 1)
    )
      if (startsWord(at)) return at;
    return -1;
  };
  const needle = query.trim().toLowerCase();
  const candidates = needle ? [needle, ...words(needle)] : [];
  for (const candidate of candidates) {
    const at = find(candidate);
    if (at >= 0)
      return [
        text.slice(0, at),
        text.slice(at, at + candidate.length),
        text.slice(at + candidate.length),
      ];
  }
  return [text, "", ""];
}

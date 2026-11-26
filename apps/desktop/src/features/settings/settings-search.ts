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
    title: "Location",
    description:
      "The app and the ticketd command both read and write this file.",
    keywords:
      "workspace file path folder sqlite database finder show copy format version size tickets documents plans count where",
    section: "backups-export",
  },
  {
    title: "Upload destination",
    description:
      "Applies to new uploads only. Queued uploads and retries keep their original destination.",
    keywords:
      "files drive local storage uploads attachments on this computer included in backups google drive account sign in attach picker",
    section: "files",
  },
  {
    title: "Upload folder",
    description: "Writable when selected. Checked again before each upload.",
    keywords: "drive change folder",
    section: "files",
  },
  {
    title: "Upload limit",
    description: "Per file, for future uploads. All file types are accepted.",
    keywords: "largest file size mib maximum default",
    section: "files",
  },
  {
    title: "Back up now",
    description:
      "Saves a checked copy to a new file you choose. It never replaces an existing file.",
    keywords: "backup copy save last backup",
    section: "backups-export",
  },
  {
    title: "What a backup contains",
    description: "Tickets, Documents, Plans, Projects, activity and evidence",
    keywords:
      "includes contents local attachment files integrity check google drive not included",
    section: "backups-export",
  },
  {
    title: "Restore from a backup",
    description:
      "Replaces this workspace after a review. A safety backup of it is saved first.",
    keywords: "restore recover replace workspace choose backup",
    section: "backups-export",
  },
  {
    title: "Safety backups",
    description:
      "Saved next to the workspace before a restore or a format upgrade, with every retained local attachment file. Restore one to undo.",
    keywords: "undo backup automatic",
    section: "backups-export",
  },
  {
    title: "Workspace as JSON",
    description:
      "Every ticket, Document and Plan, Trash included, in one file.",
    keywords: "export json snapshot download trash",
    section: "backups-export",
  },
  {
    title: "A ticket or Document as Markdown",
    description: "With its files, from the command line.",
    keywords:
      "export command line cli terminal export-markdown manifest folder portable",
    section: "backups-export",
  },
  {
    title: "Status",
    description:
      "Lets your agents and terminals run ticketd on this Workspace.",
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
    description:
      "Teaches the agents on this computer to use ticketd without being told.",
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
    section: "agents",
  },
  {
    title: "Experimental",
    description:
      "Run the coding agents on this computer inside ticketd, in Chats.",
    keywords:
      "beta preview not yet qualified against real subscriptions claude codex ai",
    section: "agents",
  },
  {
    title: "Harnesses",
    description: "Each harness runs on this computer with its own sign-in.",
    keywords:
      "harness claude code codex installed detected signed in check again copy command",
    section: "agents",
    needsChat: true,
  },
  {
    title: "Notify me about Chats",
    description: "Approvals, questions, failures and finished turns.",
    keywords: "chat notification notifications alert sound badge dock mute",
    section: "agents",
    needsChat: true,
  },
  {
    title: "Experimental",
    description: "Let agents and steps work on your tickets by themselves.",
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
    title: "Workspace sync",
    description: "Keep this Workspace the same on your other computers.",
    keywords:
      "sync cloud connect account desktops folder storage google drive s3 aws bucket profile prefix sso sign in",
    section: "workspace-sync",
  },
  {
    title: "Name",
    description: "New tickets here are numbered",
    keywords: "this desktop device ticket code",
    section: "workspace-sync",
  },
  {
    title: "Check for changes every",
    description: "Your own changes upload right after each save.",
    keywords: "check interval seconds poll sync frequency options",
    section: "workspace-sync",
  },
  {
    title: "Attachments",
    description: "Download when opened",
    keywords:
      "download automatically every file works offline saves disk space files",
    section: "workspace-sync",
  },
  {
    title: "Disconnect this desktop",
    description:
      "Stops syncing here. Your files stay in Drive and on this computer.",
    keywords:
      "disconnect google drive s3 sign out account remove unlink stop syncing",
    section: "workspace-sync",
  },
  {
    title: "Ticket sources",
    description: "Bring issues from your other trackers in as tickets.",
    keywords:
      "source sources connection connections provider account discovery refresh github linear jira issues import",
    section: "ticket-sources",
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
    description: "Records more detail until ticketd restarts.",
    keywords: "diagnostics log level verbose troubleshoot ticketd_log",
    section: "diagnostics",
  },
  {
    title: "Log files",
    description:
      "One file per day, and the oldest are removed automatically. They stay on this computer.",
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
    title: "Check for updates automatically",
    description:
      "Once a day, ticketd asks GitHub for the newest release. Nothing about you or your workspace is sent.",
    keywords: "version upgrade download install restart check",
    section: "about",
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
export function sourceEntries(
  connection: string,
  name: string,
  fields: string[] = [],
): SettingsEntry[] {
  const section: SettingsPageId = `source-${connection}`;
  return [
    {
      title: "Connection",
      description: `ticketd uses your own ${name} permissions.`,
      keywords: `${name} account sign in token permissions check connection ${connection}`,
      section,
    },
    {
      title: "Discovery",
      description: `Matching issues are imported as tickets on the next sync. Nothing is changed in ${name}.`,
      keywords: `${name} rules ${fields.join(" ")} import issues preview save ${connection}`,
      section,
    },
    {
      title: "Sync",
      description: "Agents can sync without the desktop open",
      keywords: `${name} refresh schedule source refresh command sync now ${connection}`,
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

/** Stands in for Chat-only rows while Chat is off: the Agents page is where it is turned on. */
const CHAT_PAGE_ENTRY: SettingsEntry = {
  title: "Agents",
  description:
    "Turn on Chat to set up harnesses, notifications and Automations.",
  section: "agents",
};

/**
 * `searchSettings` for the person's current Chat setting. While Chat is on every
 * entry is searched. While it is off the Chat-only rows stay hidden, but a query
 * that matches only them finds the Agents page entry instead, so the way to them
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
  if (hits.some((hit) => hit.section === "agents")) return hits;
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

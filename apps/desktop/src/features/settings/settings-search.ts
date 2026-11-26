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
    title: "Set up ticketd",
    description:
      "Finish the few things that make ticketd useful with your agents.",
    keywords:
      "set up setup checklist onboarding getting started first run steps agents hide",
    section: "setup",
  },
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
    description:
      "Changes to them reach your Inbox. Tickets agents create aren’t followed.",
    keywords: "follow following inbox",
    section: "attention",
  },
  {
    title: "System notifications",
    description:
      "Due reminders, and Chats that need you, while ticketd is open.",
    keywords:
      "notification notifications reminder alert permission allow blocked system settings",
    section: "attention",
  },
  {
    title: "Chat notifications",
    description:
      "Approvals, questions, failures and finished turns. Mute one Chat from its menu.",
    keywords: "chat notification notifications alert sound badge dock mute",
    section: "attention",
    needsChat: true,
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
    title: "New files",
    description: "Files you already attached stay where they are.",
    keywords:
      "files drive local storage uploads attachments this computer included in backups works offline google drive attach picker folder change folder uploads sync folder",
    section: "files",
  },
  {
    title: "Google account",
    description: "The one Workspace sync uses.",
    keywords:
      "files drive sign in signed out another account switch email google",
    section: "files",
  },
  {
    title: "Restore points",
    description:
      "Copies to come back to, saved on this computer every day. The last 7 are kept.",
    keywords:
      "backup back up now copy save daily restore recover replace undo safety file earlier version",
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
    title: "Command line",
    description:
      "Lets your agents and terminals run ticketd on this Workspace.",
    keywords:
      "command-line tool path terminal install cli check again executable password administrator replace older",
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
    title: "Agent skills",
    description:
      "Teaches the agents on this computer to use ticketd without being told.",
    keywords: "claude code codex agent install update skill",
    section: "agent-skills",
  },
  {
    title: "Agents on this computer",
    description:
      "The skill calls the ticketd command from Command line. To run these agents inside ticketd, see Agents.",
    keywords: "claude codex detected replace check again",
    section: "agent-skills",
  },
  {
    title: "Chats",
    description:
      "Start your agents from ticketd and follow their work beside your tickets.",
    keywords:
      "show chat claude codex ai experimental beta preview not yet tested subscription plan sidebar conversations automations",
    section: "agents",
  },
  {
    title: "On this computer",
    description:
      "To let them use ticketd in their own terminal, see Agent skills.",
    keywords:
      "agents harness claude code codex antigravity installed detected version signed in check again copy command",
    section: "agents",
  },
  {
    title: "Start ticketd when you sign in",
    description: "Scheduled Automations run only while ticketd is running.",
    keywords:
      "automation automations login startup autostart launch background tray boot schedule",
    section: "automations",
  },
  {
    title: "Open Automations",
    description: "Build them, and choose which ones run on this computer.",
    keywords:
      "automation automations build schedule agents steps experimental beta preview",
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
    title: "Computers",
    description: "This computer",
    keywords:
      "rename name this computer desktop device ticket code last change",
    section: "workspace-sync",
  },
  {
    title: "Check for changes every",
    description: "Your own changes upload right after each save.",
    keywords: "check interval seconds poll sync frequency options",
    section: "workspace-sync",
  },
  {
    title: "Files from your other computers",
    description: "Download when opened",
    keywords:
      "attachments download automatically every file works offline saves disk space files",
    section: "workspace-sync",
  },
  {
    title: "Stop syncing on this computer",
    description: "Your files stay in Drive and on this computer.",
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
    description:
      "Letter keys pause while you type or while a dialog or menu is open.",
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
    description: "On the open ticket, or the focused one in a list or board.",
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
    title: "Detailed logging",
    description:
      "Turn it on, repeat what went wrong, then save a report to attach to a GitHub issue.",
    keywords:
      "diagnostics debug log level verbose troubleshoot ticketd_log report bug issue support export zip start save",
    section: "diagnostics",
  },
  {
    title: "Log files",
    description: "Kept for 7 days on this computer.",
    keywords: "diagnostics logs folder open finder",
    section: "diagnostics",
  },
  {
    title: "Recent errors",
    description: "From the last 7 days of logs.",
    keywords: "diagnostics crash failure warning unexpected quit",
    section: "diagnostics",
  },
  {
    title: "Check for updates automatically",
    description:
      "Once a day, from GitHub. Nothing about you or your Workspace is sent.",
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
    description: "Opens GitHub’s bug form with your version filled in.",
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
    "Turn on Chats to see how each agent signs in, and to use Automations.",
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

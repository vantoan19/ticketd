import {
  Archive,
  Bell,
  Bot,
  CircleDot,
  Contrast,
  Folder,
  Info,
  Keyboard,
  ListChecks,
  Puzzle,
  RefreshCw,
  ScrollText,
  Search,
  Terminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export type SettingsGroup =
  "Settings" | "Preferences" | "Workspace" | "AI" | "Connections" | "Help";

/**
 * The Settings pages, in nav order. The nav is built from this array and every
 * entry has a page in `pages/`; add a page here and its file together. `job`
 * is the one line under the page's title: what the page is for, in the
 * person's words (backticks mark a command). Search reads it too.
 *
 * Connections are not listed: the sidebar never lists individual things. A
 * connection is a row on Ticket sources that opens in place (`source-<id>`,
 * see `SettingsDrillIn`).
 */
export const SETTINGS_SECTIONS = [
  // Above the groups, with no heading, until it is finished or hidden.
  {
    id: "setup",
    label: "Set up ticketd",
    group: "Settings",
    icon: ListChecks,
    job: "Finish the few things that make ticketd useful with your agents.",
  },
  {
    id: "appearance",
    label: "Appearance",
    group: "Preferences",
    icon: Contrast,
    job: "How ticketd looks on this computer.",
  },
  {
    id: "attention",
    label: "Attention",
    group: "Preferences",
    icon: Bell,
    job: "What reaches your Inbox, and when ticketd notifies you.",
  },
  {
    id: "workspace-sync",
    label: "Workspace sync",
    group: "Workspace",
    icon: RefreshCw,
    job: "Keep this Workspace the same on your other computers.",
  },
  {
    id: "files",
    label: "Files",
    group: "Workspace",
    icon: Folder,
    job: "Where files you attach to tickets and Documents are kept.",
  },
  {
    id: "backups-export",
    label: "Backups & export",
    group: "Workspace",
    icon: Archive,
    job: "Where this Workspace lives, copies you can go back to, and how to take it with you.",
  },
  {
    id: "command-line",
    label: "Command line",
    group: "AI",
    icon: Terminal,
    job: "Lets your agents and terminals run `ticketd` on this Workspace.",
  },
  {
    id: "agent-skills",
    label: "Agent skills",
    group: "AI",
    icon: Puzzle,
    job: "Teaches the agents on this computer to use ticketd without being told.",
  },
  {
    id: "agents",
    label: "Agents",
    group: "AI",
    icon: Bot,
    job: "Run the coding agents on this computer inside ticketd, in Chats.",
  },
  // Listed only while Chats are on.
  {
    id: "automations",
    label: "Automations",
    group: "AI",
    icon: Workflow,
    job: "Let agents and steps work on your tickets by themselves.",
  },
  {
    id: "ticket-sources",
    label: "Ticket sources",
    group: "Connections",
    icon: CircleDot,
    job: "Bring issues from your other trackers in as tickets.",
  },
  {
    id: "keyboard-shortcuts",
    label: "Keyboard shortcuts",
    group: "Help",
    icon: Keyboard,
    job: "Every keyboard shortcut in one list.",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    group: "Help",
    icon: ScrollText,
    job: "Gather what’s needed to report a problem.",
  },
  {
    id: "about",
    label: "About",
    group: "Help",
    icon: Info,
    job: "Your version, updates, and ways to support ticketd.",
  },
] as const satisfies readonly {
  id: string;
  label: string;
  group: SettingsGroup;
  icon: LucideIcon;
  job: string;
}[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const SETTINGS_GROUPS: SettingsGroup[] = [
  "Preferences",
  "Workspace",
  "AI",
  "Connections",
  "Help",
];

/** What decides which page Settings opens on. */
export interface SettingsOpening {
  /** Set up ticketd is neither finished nor hidden. */
  setupPending: boolean;
  /** The first page with a problem the person has to fix (`pageNeedingYou`), if any. */
  needs?: SettingsSectionId | null;
  /** The page the person last used, as stored: an old name, or one that no longer exists, is tolerated. */
  last?: string | null;
  /** Chats are on, so Automations is in the sidebar. Left out, every page is listed. */
  chatsOn?: boolean;
}

/**
 * The page Settings opens on, in this order: the page that needs the person,
 * else Set up ticketd while it is unfinished, else the page last visited, else
 * Appearance. This is the one place the rule lives.
 */
export function initialSettingsPage(opening: SettingsOpening): SettingsPageId {
  if (opening.needs) return opening.needs;
  if (opening.setupPending) return "setup";
  const last = opening.last ? resolveSettingsPage(opening.last) : null;
  // Set up ticketd has left the sidebar by now; Search and a thing opened in place are not pages to come back to.
  const listed = last !== "automations" || opening.chatsOn !== false;
  if (last && listed && navSectionOf(last) === last && last !== "setup")
    return last;
  return "appearance";
}

/** The id of the search field in the nav, which ⌘F and Ctrl+F focus. */
export const SEARCH_INPUT_ID = "settings-search-input";

/**
 * A page Settings can open: a section, Search, a connection opened in place
 * (`source-<connection id>`, shown under Ticket sources) or an agent opened in
 * place (`agent:<harness id>`, shown under Agents). The agent prefix has a colon
 * because no section id has one: `agent-skills` is a section of its own.
 */
export type SettingsPageId =
  SettingsSectionId | "search" | `source-${string}` | `agent:${string}`;

/** The page id of an agent opened in place. */
export function agentPageId(harnessId: string): SettingsPageId {
  return `agent:${harnessId}`;
}

/**
 * Page names that earlier versions used, in saved state, links and code that
 * has not caught up. Each lands on the page that took its content.
 */
const LEGACY_PAGES = {
  attachments: "files",
  "google-drive": "files",
  location: "backups-export",
  backups: "backups-export",
  export: "backups-export",
  chat: "agents",
  sources: "ticket-sources",
} as const satisfies Record<string, SettingsSectionId>;

export type LegacySettingsPageId = keyof typeof LEGACY_PAGES;

/** The current page for an id that may be an old name; an unknown id opens Appearance. */
export function resolveSettingsPage(page: string): SettingsPageId {
  if (Object.hasOwn(LEGACY_PAGES, page)) return LEGACY_PAGES[page as LegacySettingsPageId];
  if (
    page === "search" ||
    page.startsWith("source-") ||
    page.startsWith("agent:")
  )
    return page as SettingsPageId;
  return SETTINGS_SECTIONS.some((section) => section.id === page)
    ? (page as SettingsSectionId)
    : "appearance";
}

/** The sidebar entry a page belongs to: a connection opens under Ticket sources, an agent under Agents, Search under none. */
export function navSectionOf(page: SettingsPageId): SettingsSectionId | null {
  if (page === "search") return null;
  if (page.startsWith("source-")) return "ticket-sources";
  if (page.startsWith("agent:")) return "agents";
  return page as SettingsSectionId;
}

/** What every page names itself with: its breadcrumb, header icon and job line. */
export interface SettingsPageMeta {
  group: string;
  label: string;
  icon: LucideIcon;
  lede: string;
}

/** The entry for a section, to spread onto its `SettingsPage`. */
export function sectionMeta(id: SettingsSectionId): SettingsPageMeta {
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`Unknown settings section ${id}`);
  return {
    group: section.group,
    label: section.label,
    icon: section.icon,
    lede: section.job,
  };
}

/** Search is opened by typing in the nav's field, not from a group. */
export const SEARCH_PAGE: SettingsPageMeta = {
  group: "Settings",
  label: "Search",
  icon: Search,
  lede: "Find any setting by name.",
};

/** A connection's page, for Search results: it opens in place under Ticket sources. */
export function sourceSection(
  provider: string,
  name: string,
  iconSvg?: string | null,
) {
  return {
    id: `source-${provider}` as const,
    label: name,
    group: "Connections" as const,
    icon: CircleDot as LucideIcon,
    iconSvg,
  };
}

/** The DOM id of a card on a Settings page. */
export function settingsCardId(id: string) {
  return `settings-${id}`;
}

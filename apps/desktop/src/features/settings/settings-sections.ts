import {
  Bell,
  Bot,
  Cloud,
  CircleDot,
  Contrast,
  Database,
  History,
  Info,
  Keyboard,
  MessageCircle,
  Paperclip,
  RefreshCw,
  ScrollText,
  Search,
  Terminal,
  Upload,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export type SettingsGroup =
  "Preferences" | "Workspace" | "Agents" | "Connections" | "Help";

/**
 * The Settings sections, in nav order. The nav is built from this array and
 * every entry has a page in `pages/`; add a section here and its page together.
 * Sources are not listed: each available source adds `source-<provider>` under
 * Connections after Google Drive.
 */
export const SETTINGS_SECTIONS = [
  {
    id: "appearance",
    label: "Appearance",
    group: "Preferences",
    icon: Contrast,
  },
  { id: "attention", label: "Attention", group: "Preferences", icon: Bell },
  { id: "location", label: "Location", group: "Workspace", icon: Database },
  {
    id: "workspace-sync",
    label: "Workspace sync",
    group: "Workspace",
    icon: RefreshCw,
  },
  {
    id: "attachments",
    label: "Attachments",
    group: "Workspace",
    icon: Paperclip,
  },
  { id: "backups", label: "Backups", group: "Workspace", icon: History },
  { id: "export", label: "Export", group: "Workspace", icon: Upload },
  {
    id: "command-line",
    label: "Command line",
    group: "Agents",
    icon: Terminal,
  },
  { id: "agent-skills", label: "Agent skills", group: "Agents", icon: Bot },
  { id: "chat", label: "Chat", group: "Agents", icon: MessageCircle },
  // Listed only while Chat is on.
  {
    id: "automations",
    label: "Automations",
    group: "Agents",
    icon: Workflow,
  },
  {
    id: "google-drive",
    label: "Google Drive",
    group: "Connections",
    icon: Cloud,
  },
  {
    id: "keyboard-shortcuts",
    label: "Keyboard shortcuts",
    group: "Help",
    icon: Keyboard,
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    group: "Help",
    icon: ScrollText,
  },
  { id: "about", label: "About", group: "Help", icon: Info },
] as const satisfies readonly {
  id: string;
  label: string;
  group: SettingsGroup;
  icon: LucideIcon;
}[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const SETTINGS_GROUPS: SettingsGroup[] = [
  "Preferences",
  "Workspace",
  "Agents",
  "Connections",
  "Help",
];

/** A page Settings can open: a section, Search, or an available source. */
export type SettingsPageId = SettingsSectionId | "search" | `source-${string}`;

/** What every page names itself with: its breadcrumb and header icon. */
export interface SettingsPageMeta {
  group: string;
  label: string;
  icon: LucideIcon;
}

/** The entry for a section, to spread onto its `SettingsPage`. */
export function sectionMeta(id: SettingsSectionId): SettingsPageMeta {
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`Unknown settings section ${id}`);
  return { group: section.group, label: section.label, icon: section.icon };
}

/** Search is opened from the nav's Search entry, not from a group. */
export const SEARCH_PAGE: SettingsPageMeta = {
  group: "Settings",
  label: "Search",
  icon: Search,
};

/** The nav entry for an available source, listed under Connections. */
export function sourceSection(provider: string, name: string) {
  return {
    id: `source-${provider}` as const,
    label: name,
    group: "Connections" as const,
    icon: CircleDot as LucideIcon,
  };
}

/** The DOM id of a card on a Settings page. */
export function settingsCardId(id: string) {
  return `settings-${id}`;
}

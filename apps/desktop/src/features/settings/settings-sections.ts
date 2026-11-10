export type SettingsGroup = "Preferences" | "Workspace" | "Sources" | "Help";

/**
 * The Settings cards in page order. The section list is built from the same
 * array, so it only offers sections whose cards exist; add a card here and in the page together.
 */
export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", group: "Preferences" },
  { id: "attention", label: "Attention", group: "Preferences" },
  { id: "location", label: "Location", group: "Workspace" },
  { id: "attachments", label: "Attachments", group: "Workspace" },
  { id: "backups", label: "Backups", group: "Workspace" },
  { id: "export", label: "Export", group: "Workspace" },
  { id: "command-line", label: "Command line", group: "Workspace" },
  { id: "agent-skills", label: "Agent skills", group: "Workspace" },
  { id: "keyboard-shortcuts", label: "Keyboard shortcuts", group: "Help" },
  { id: "about", label: "About", group: "Help" },
] as const satisfies readonly {
  id: string;
  label: string;
  group: SettingsGroup;
}[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const SETTINGS_GROUPS: SettingsGroup[] = [
  "Preferences",
  "Workspace",
  "Sources",
  "Help",
];

/** A card id: a Settings section, another page borrowing the card (Projects), or a source. */
export type SettingsCardKey =
  SettingsSectionId | `project-${string}` | `source-${string}`;

/** The section for an available source, listed under Sources beside its card. */
export function sourceSection(provider: string, name: string) {
  return {
    id: `source-${provider}` as SettingsCardKey,
    label: name,
    group: "Sources" as SettingsGroup,
  };
}

export function settingsCardId(id: SettingsCardKey) {
  return `settings-${id}`;
}

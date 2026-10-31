export type SettingsGroup = "Preferences" | "Workspace" | "Help";

/**
 * The Settings cards in page order. The section list is built from the same
 * array, so it only offers sections whose cards exist; add a card here and in the page together.
 */
export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", group: "Preferences" },
  { id: "attention", label: "Attention", group: "Preferences" },
  { id: "location", label: "Location", group: "Workspace" },
  { id: "backups", label: "Backups", group: "Workspace" },
  { id: "export", label: "Export", group: "Workspace" },
  { id: "command-line", label: "Command line", group: "Workspace" },
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
  "Help",
];

/** A card id: a Settings section, or another page borrowing the card (Projects). */
export type SettingsCardKey = SettingsSectionId | `project-${string}`;

export function settingsCardId(id: SettingsCardKey) {
  return `settings-${id}`;
}

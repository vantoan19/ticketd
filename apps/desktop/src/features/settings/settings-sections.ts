export type SettingsGroup = "Preferences" | "Workspace" | "Help";

/**
 * The Settings cards in page order. The section list is built from the same
 * array, so it only offers sections whose cards exist; add Attention,
 * Location, and Command line here when their cards arrive.
 */
export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", group: "Preferences" },
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

export function settingsCardId(id: SettingsSectionId) {
  return `settings-${id}`;
}

function platformName(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform || "";
}

/** The label for the platform's primary modifier key. */
export function modifierKeyLabel(): string {
  return /mac|iphone|ipad/i.test(platformName()) ? "⌘" : "Ctrl";
}

/** What the platform calls its file manager, for "Show in …" actions. */
export function fileManagerName(): string {
  const platform = platformName();
  if (/mac/i.test(platform)) return "Finder";
  if (/win/i.test(platform)) return "Explorer";
  return "File Manager";
}

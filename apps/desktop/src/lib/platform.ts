function platformName(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform || "";
}

/** Whether keys are written with macOS glyphs (⌘ ⇧ ⌥). */
export function isMacPlatform(): boolean {
  return /mac|iphone|ipad/i.test(platformName());
}

/** The label for the platform's primary modifier key. */
export function modifierKeyLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

/** What the platform calls its file manager, for "Show in …" actions. */
export function fileManagerName(): string {
  const platform = platformName();
  if (/mac/i.test(platform)) return "Finder";
  if (/win/i.test(platform)) return "Explorer";
  return "File Manager";
}

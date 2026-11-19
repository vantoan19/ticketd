function platformName(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform || "";
}

/** Whether keys are written with macOS glyphs (⌘ ⇧ ⌥). */
export function isMacPlatform(): boolean {
  return /mac|iphone|ipad/i.test(platformName());
}

/**
 * Whether the WebView is WebKitGTK, whose media elements cannot play from a
 * custom URI scheme (https://bugs.webkit.org/show_bug.cgi?id=146351).
 */
export function isLinuxPlatform(): boolean {
  return /linux/i.test(platformName());
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

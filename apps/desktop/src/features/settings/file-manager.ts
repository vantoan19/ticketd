/** What the platform calls its file manager, for "Show in …" actions. */
export function fileManagerName() {
  const platform =
    typeof navigator === "undefined" ? "" : navigator.platform || "";
  if (/mac/i.test(platform)) return "Finder";
  if (/win/i.test(platform)) return "Explorer";
  return "File Manager";
}

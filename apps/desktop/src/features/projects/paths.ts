/** A folder path with the user's home folder written as "~", for display. */
export function homeRelative(path: string): string {
  return path.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, "~");
}

/** Splits a display path into the part that may shrink and the folder name that stays. */
export function splitPath(path: string): { head: string; tail: string } {
  const at = path.lastIndexOf("/");
  if (at <= 0) return { head: "", tail: path };
  return { head: path.slice(0, at + 1), tail: path.slice(at + 1) };
}

/** A project name suggested by a folder: "mobile-app" becomes "Mobile App". */
export function nameFromFolder(path: string): string {
  const folder =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return folder
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

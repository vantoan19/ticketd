import type { FailureDescription } from "@/lib/api/describe-failure";

/**
 * A failure a helper already put in one line, such as revealFile's
 * "Couldn't show the file in Finder. It was moved.", as an Alert's title and
 * sentence. It carries no raw text, so it has no Details.
 */
export function lineFailure(text: string): FailureDescription {
  const cut = text.indexOf(". ");
  return {
    code: "failed",
    title: (cut < 0 ? text : text.slice(0, cut)).replace(/\.$/, ""),
    sentence: cut < 0 ? "" : text.slice(cut + 2),
    action: null,
    details: "",
  };
}

/** Today's date as YYYY-MM-DD in local time, for suggested file names. */
export function localDate() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A file path as its folder and file name, for either kind of separator. */
export function splitPath(path: string) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0
    ? { folder: "", name: path }
    : {
        folder: path.slice(0, cut) || path.slice(0, 1),
        name: path.slice(cut + 1),
      };
}

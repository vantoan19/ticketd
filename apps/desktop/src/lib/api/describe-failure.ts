import { toFailure, type FailureCode } from "./bridge-failure";

/**
 * What a failure says to people, decided by its kind: a title naming what did
 * not happen ("Couldn't archive Docs launch"), one sentence with the plain cause
 * and what is safe, the next step, and the raw text for "Details" only.
 */
export type FailureDescription = {
  code: FailureCode;
  /** "Couldn't {verb} {object}", sentence case, no period. */
  title: string;
  /** The plain cause and what is safe, ending with a period. */
  sentence: string;
  /**
   * The next step: `retry` only when retrying can succeed; otherwise the fix
   * the caller offers (`change_limit`, `reconnect`, `reload`, `choose_another`),
   * or nothing when only time or another place can fix it.
   */
  action:
    "retry" | "change_limit" | "reconnect" | "reload" | "choose_another" | null;
  /** The raw message, for Details and Copy details. Never shown in the flow. */
  details: string;
};

// Prefixes the core and the host put in front of a message; Details keeps them.
const hostPrefixes = [
  /^error:\s*/i,
  /^workspace database error:\s*/i,
  /^could not access workspace directory:\s*/i,
  /^attachment:\s*/i,
  /^drive:\s*/i,
  /^sync storage:\s*/i,
  /^storage:\s*/i,
  /^sync:\s*/i,
  /^backup or restore failed:\s*/i,
  /^invalid chat record:\s*/i,
  /^invalid batch:\s*/i,
  /^batch operation \d+:\s*/i,
];

/**
 * Host or core text made fit to read inside a sentence: trimmed, without
 * internal prefixes or CLI commands in backticks, capitalized, and ending with
 * a period, so it never runs into the next sentence.
 */
export function sentence(text: string): string {
  let result = text.trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const prefix of hostPrefixes) {
      const next = result.replace(prefix, "");
      if (next !== result) {
        result = next;
        changed = true;
      }
    }
  }
  // "…restore it with `ticketd document restore T-1` first" → "…restore it first".
  result = result
    .replace(/\s*(?:,\s*)?(?:\bwith|\bor|\busing|\brun)?\s*`[^`]*`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!result) return "";
  result = result.charAt(0).toUpperCase() + result.slice(1);
  return /[.!?…]$/.test(result) ? result : `${result}.`;
}

function plainCause(
  code: FailureCode,
  message: string,
  readable: boolean,
): string {
  switch (code) {
    case "workspace_read_only":
      return "The workspace is read-only, so nothing changed.";
    case "workspace_locked":
      return "Another ticketd operation is using the workspace. Nothing changed.";
    case "disk_full":
      return "The disk is full, so nothing changed.";
    case "workspace_unreadable":
      return "ticketd can't read the workspace file. Nothing changed.";
    case "not_found":
      // The S3 bucket check says which bucket is missing, in words for people.
      return readable && sentence(message)
        ? sentence(message)
        : "It was deleted or moved.";
    case "conflict":
      return "It changed elsewhere since it was loaded. Nothing was overwritten.";
    case "too_large":
      return "The file is larger than the upload limit.";
    case "not_signed_in":
    case "unauthenticated":
      return "The account needs to be connected again.";
    case "drive_unconfigured":
      return "This build of ticketd has no Google Drive app configuration. Install a build with Google Drive enabled. Your local files are unaffected.";
    case "sign_in_cancelled":
      return "Sign-in wasn't finished in your browser, so nothing changed.";
    case "offline":
    case "unavailable":
      return "ticketd can't reach the service. Check the connection.";
    case "rate_limited":
      return "The service asked ticketd to slow down. Wait a moment.";
    case "forbidden":
      return "The account isn't allowed to do this.";
    case "cycle":
      return `${sentence(message)} Choose another ticket.`;
    case "publication_failed":
      return "The source refused the publication. Nothing was created. Try again.";
    case "publication_unresolved":
      return "The issue may already exist. Review the publication outcome before trying again.";
    case "publication_changed":
      return "The ticket changed since its preview, so nothing was sent. Review the updated preview before publishing.";
    case "publication_ineligible":
      return "This ticket cannot be published in its current state. Review the updated preview.";
    case "publication_different_content":
      return "The issue has different content from the text sent. Review the difference before attaching.";
    case "publication_unverified":
      return "The outcome could not be verified. The attempt stays unresolved. Check again when the source is available.";
    case "publication_candidates":
      return "Possible matching issues still need review. Attach a matching issue or check again.";
    case "publication_mismatch":
      return "The issue does not match this publication. Choose another issue.";
    case "publication_settled":
      return "This publication was resolved elsewhere. Reload to review its saved outcome.";
    case "publication_nothing_to_resolve":
      return "There is no unresolved publication to review. Reload the ticket.";
    case "publication_still_running":
      return "Publication is still running. Wait and check again.";
    default:
      // A caller whose host messages are worded for people (the S3 setup says
      // what to fix: a bad bucket name, a missing bucket) shows its own text.
      if (readable && code === "failed" && sentence(message))
        return sentence(message);
      // An unclassified host message can contain paths, diagnostics or secrets.
      // The write may have committed before its reply failed, so make no
      // claim that nothing changed; the action-specific title names the request.
      return "The result couldn't be confirmed. Check the saved state before trying again.";
  }
}

function nextStep(code: FailureCode): FailureDescription["action"] {
  switch (code) {
    case "too_large":
      return "change_limit";
    case "not_signed_in":
    case "unauthenticated":
      return "reconnect";
    case "conflict":
    case "review_changed":
    case "publication_changed":
    case "publication_ineligible":
    case "publication_settled":
    case "publication_nothing_to_resolve":
    case "publication_still_running":
    case "publication_unverified":
    case "publication_unresolved":
      return "reload";
    case "cycle":
    case "not_found":
    case "publication_mismatch":
      return "choose_another";
    case "forbidden":
    case "drive_unconfigured":
    case "workspace_unreadable":
    case "publication_different_content":
    case "publication_candidates":
      return null;
    default:
      return "retry";
  }
}

/**
 * Describes a failure for people. `action` is what did not happen, as a verb
 * phrase: "archive Docs launch", "save the title", "load Documents".
 * `readable` says the host worded an unclassified (`failed`) message for people
 * and names what to fix, so it is the sentence instead of the generic one.
 */
export function describeFailure(
  reason: unknown,
  action: string,
  { readable = false }: { readable?: boolean } = {},
): FailureDescription {
  const failure = toFailure(reason);
  const code = failure.kind;
  return {
    code,
    title: `Couldn't ${action}`,
    sentence: plainCause(code, failure.message, readable),
    action: nextStep(code),
    details: failure.message,
  };
}

/**
 * The same failure as one line, for places that hold a single string (a
 * tooltip, a status caption, an aria-label): "Couldn't save the title. The
 * workspace is read-only, so nothing changed."
 */
export function failureText(reason: unknown, action: string): string {
  const { title, sentence } = describeFailure(reason, action);
  return `${title}. ${sentence}`;
}

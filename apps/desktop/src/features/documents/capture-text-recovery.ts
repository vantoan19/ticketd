import { unified } from "unified";
import remarkParse from "remark-parse";

const parser = unified().use(remarkParse);

/** Conservative check of canonical Markdown, including parsed reference-link URLs.
 * Browser recovery cannot retain attachment bytes; any possible attachment URI
 * keeps the core protection guard in charge, even inside code or raw HTML.
 */
function needsAttachmentProtection(value: unknown): boolean {
  if (typeof value === "string") {
    if (/ticketd\s*:\/\/attachment(?:\/|$)|attachment\//i.test(value))
      return true;
    return needsAttachmentProtection(parser.parse(value).children);
  }
  if (Array.isArray(value)) return value.some(needsAttachmentProtection);
  if (value && typeof value === "object") {
    // Parsed nodes' source text must not be parsed recursively again.
    return Object.entries(value).some(([key, child]) =>
      key === "value" || key === "url"
        ? typeof child === "string" &&
          /ticketd\s*:\/\/attachment(?:\/|$)|attachment\//i.test(child)
        : typeof child === "object" && needsAttachmentProtection(child),
    );
  }
  return false;
}

function key(workspaceId: string) {
  return `ticketd:capture-text-fallback:${workspaceId}`;
}
export async function readCaptureTextDraft(
  workspaceId: string,
): Promise<unknown> {
  const raw = localStorage.getItem(key(workspaceId));
  return raw ? (JSON.parse(raw) as unknown) : null;
}
export async function keepCaptureTextDraft(
  workspaceId: string,
  payload: unknown,
): Promise<void> {
  // Payload contains current, pending, discarded and external Markdown: all
  // recoverable states must be free of attachment references.
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : [];
  if (strings(payload).some(needsAttachmentProtection))
    throw new Error(
      "Attachment drafts need workspace recovery before closing.",
    );
  const storageKey = key(workspaceId);
  const serialized = JSON.stringify(payload);
  localStorage.setItem(storageKey, serialized);
  if (localStorage.getItem(storageKey) !== serialized)
    throw new Error("The text draft could not be verified on this device.");
}
export async function clearCaptureTextDraft(workspaceId: string) {
  localStorage.removeItem(key(workspaceId));
}

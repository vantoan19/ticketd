/**
 * Writes to the clipboard. Resolves to why it failed in plain words, or null
 * on success; never throws. The browser's own reason is never shown: it only
 * ever says that permission was refused.
 */
export async function writeClipboard(text: string): Promise<string | null> {
  try {
    if (!navigator.clipboard) return "the clipboard is unavailable";
    await navigator.clipboard.writeText(text);
    return null;
  } catch {
    return "the clipboard refused it";
  }
}

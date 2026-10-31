/** Writes to the clipboard. Resolves to why it failed, or null on success; never throws. */
export async function writeClipboard(text: string): Promise<string | null> {
  try {
    if (!navigator.clipboard) return "the clipboard is unavailable";
    await navigator.clipboard.writeText(text);
    return null;
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}

/**
 * Writes to the clipboard. Resolves to why it failed in plain words, or null
 * on success; never throws. The browser's own reason is never shown: it only
 * ever says that permission was refused.
 */
export async function writeClipboard(
  text: string | Promise<string>,
): Promise<string | null> {
  try {
    if (
      typeof text !== "string" &&
      navigator.clipboard?.write &&
      typeof ClipboardItem !== "undefined"
    ) {
      // WebKit requires the clipboard write to start within the user gesture,
      // even when the text arrives later from the desktop bridge.
      const content = text.then(
        (value) => new Blob([value], { type: "text/plain" }),
      );
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": content }),
      ]);
      return null;
    }
    const content = typeof text === "string" ? text : await text;
    if (!navigator.clipboard) return "the clipboard is unavailable";
    await navigator.clipboard.writeText(content);
    return null;
  } catch {
    return "the clipboard refused it";
  }
}

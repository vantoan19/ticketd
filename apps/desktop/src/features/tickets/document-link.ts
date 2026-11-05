/**
 * The body without its links to one Document. A line that only introduced the
 * link goes away with it; a link inside a sentence keeps its text.
 */
export function withoutDocumentLink(body: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = new RegExp(
    `\\[([^\\]]*)\\]\\(ticketd://document/${escaped}[^)]*\\)`,
    "g",
  );
  const lines = body.split("\n").flatMap((line) => {
    if (!link.test(line)) return [line];
    link.lastIndex = 0;
    const bare = line.replace(link, "").trim();
    if (bare === "" || bare === "Document:") return [];
    return [line.replace(link, "$1")];
  });
  const text = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return text ? `${text}\n` : "";
}

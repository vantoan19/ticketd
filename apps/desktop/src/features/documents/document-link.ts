/** The Markdown link that references a Document, with the target's heading as its text. */
export function documentLinkMarkdown(id: string, heading: string): string {
  return `[${heading.replace(/[[\]]/g, "")}](ticketd://document/${id})`;
}

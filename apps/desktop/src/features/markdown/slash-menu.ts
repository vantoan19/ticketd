export const insertions = [
  ["p", "Paragraph"],
  ["h1", "Heading 1"],
  ["h2", "Heading 2"],
  ["h3", "Heading 3"],
  ["ul", "Bullet list"],
  ["ol", "Numbered list"],
  ["task", "Checklist"],
  ["blockquote", "Quote"],
  ["code_block", "Code fence"],
  ["hr", "Divider"],
  ["table", "Table"],
  ["mermaid", "Mermaid diagram"],
] as const;

/** Slash commands match titles by prefix, so "/tab" finds Table but "/ist" finds nothing. */
export function slashChoices(query: string) {
  const needle = query.toLowerCase();
  return insertions.filter(([, title]) =>
    title.toLowerCase().startsWith(needle),
  );
}

/** "/" is a deliberate command only at the start of a block or after whitespace, never inside a word or URL. */
export function slashMayOpen(textBeforeCaret: string) {
  return textBeforeCaret === "" || /\s$/.test(textBeforeCaret);
}

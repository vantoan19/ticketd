/** Show Markdown links by their text so passages read as prose. */
export function plainPassage(markdown: string) {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "");
}

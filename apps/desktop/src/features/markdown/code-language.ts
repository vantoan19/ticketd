const languageLabels = new Map([
  ["typescript", "TypeScript"],
  ["ts", "TypeScript"],
  ["javascript", "JavaScript"],
  ["js", "JavaScript"],
  ["json", "JSON"],
  ["rust", "Rust"],
  ["python", "Python"],
  ["py", "Python"],
  ["bash", "Bash"],
  ["sh", "Bash"],
  ["shell", "Bash"],
  ["sql", "SQL"],
  ["html", "HTML"],
  ["xml", "XML"],
  ["css", "CSS"],
  ["markdown", "Markdown"],
  ["md", "Markdown"],
]);

/** Display names do not replace the fence's stored language token. */
export function codeLanguageLabel(language: string): string {
  return languageLabels.get(language.toLowerCase()) ?? language;
}

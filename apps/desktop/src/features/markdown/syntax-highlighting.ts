import { createLowlight } from "lowlight";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

const languages = {
  bash,
  css,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
};
for (const [name, language] of Object.entries(languages))
  hljs.registerLanguage(name, language);

export const syntaxHighlighter = hljs;

// Plate decorates its existing text leaves. Use the same grammars and bound as
// reading, keeping unknown languages and unusually large fences as plain text.
const lowlight = createLowlight(languages);
export const codeLowlight: ReturnType<typeof createLowlight> = {
  ...lowlight,
  highlight(language, value, options) {
    if (value.length > 50000 || !lowlight.registered(language))
      return { type: "root", children: [], data: { language, relevance: 0 } };
    return lowlight.highlight(language, value, options);
  },
  highlightAuto(value, options) {
    if (value.length > 50000)
      return { type: "root", children: [], data: { relevance: 0 } };
    return lowlight.highlightAuto(value, options);
  },
};

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

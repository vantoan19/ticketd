import { createLowlight } from "lowlight";
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

export { codeLanguageLabel } from "./code-language";

/**
 * The one highlighting engine, for reading (SyntaxCode) and for Plate's code
 * blocks. Unknown languages and unusually large fences stay plain text.
 */
const lowlight = createLowlight({
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
});
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

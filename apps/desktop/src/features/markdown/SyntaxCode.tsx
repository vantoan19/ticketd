import { useMemo } from "react";
import DOMPurify from "dompurify";
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

for (const [name, language] of Object.entries({
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
}))
  hljs.registerLanguage(name, language);

export function SyntaxCode({
  source,
  language,
}: {
  source: string;
  language: string;
}) {
  const html = useMemo(() => {
    if (source.length > 50000 || !hljs.getLanguage(language)) return null;
    return DOMPurify.sanitize(
      hljs.highlight(source, { language, ignoreIllegals: true }).value,
      { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"] },
    );
  }, [source, language]);
  return html === null ? (
    <code>{source}</code>
  ) : (
    <code dangerouslySetInnerHTML={{ __html: html }} />
  );
}

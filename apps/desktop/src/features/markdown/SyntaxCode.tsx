import { useMemo } from "react";
import DOMPurify from "dompurify";
import { syntaxHighlighter as hljs } from "./syntax-highlighting";

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

import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram";
import { CopySourceButton } from "./CopySourceButton";

// Use the original fence interior: the Markdown AST normalizes CRLF and adds a
// presentation newline. Container fences use the parser's de-indented content.
function fenceSource(
  document: string,
  node: ExtraProps["node"],
  fallback: string,
) {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (start === undefined || end === undefined) return fallback;
  const block = document.slice(start, end);
  const opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/.exec(block);
  if (!opening) return fallback;
  const body = block.slice(opening[0].length);
  const fence = opening[1] ?? "```";
  const closing = new RegExp(
    `^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`,
    "m",
  ).exec(body);
  return closing ? body.slice(0, closing.index) : body;
}

export function MarkdownDocument({ source }: { source: string }) {
  return (
    <div className="markdown-document">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} rel="noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          table: ({ children }) => (
            <div
              className="markdown-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Table"
            >
              <table>{children}</table>
            </div>
          ),
          pre: ({ node, children }) => {
            const code = node?.children[0];
            const language =
              code?.type === "element"
                ? String(code.properties.className ?? "").replace(
                    /^language-/,
                    "",
                  )
                : "";
            const text =
              code?.type === "element"
                ? code.children
                    .map((child) => (child.type === "text" ? child.value : ""))
                    .join("")
                : "";
            const content = fenceSource(source, node, text);
            if (language.toLowerCase() === "mermaid")
              return <MermaidDiagram source={content} />;
            return (
              <div className="markdown-code-block">
                <div className="markdown-block-toolbar">
                  <span>{language || "Code"}</span>
                  <CopySourceButton label="Copy code" source={content} />
                </div>
                <pre tabIndex={0}>{children}</pre>
              </div>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

import { createContext, useContext } from "react";
import ReactMarkdown, {
  type Components,
  type ExtraProps,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { SyntaxCode } from "./SyntaxCode";
import { MermaidDiagram } from "./MermaidDiagram";
import { CopySourceButton } from "./CopySourceButton";

const MarkdownSource = createContext("");
const remarkPlugins = [remarkGfm];

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

function CodeBlock({ node }: ExtraProps) {
  const source = useContext(MarkdownSource);
  const code = node?.children[0];
  const language =
    code?.type === "element"
      ? String(code.properties.className ?? "").replace(/^language-/, "")
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
      <pre tabIndex={0}>
        <SyntaxCode source={content} language={language} />
      </pre>
    </div>
  );
}

// React treats each component function as a type. Recreating these functions
// during workspace polling would remount diagrams and discard their SVG/state.
const components: Components = {
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
  pre: CodeBlock,
};

export function MarkdownDocument({ source }: { source: string }) {
  return (
    <div className="markdown-document">
      <MarkdownSource.Provider value={source}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          skipHtml
          components={components}
        >
          {source}
        </ReactMarkdown>
      </MarkdownSource.Provider>
    </div>
  );
}

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DocumentNavigation,
  PlanNavigation,
} from "@/features/documents/navigation";
import { documents } from "@/features/documents/api";
import { workspaceClient } from "@/lib/api/workspace";
import { SyntaxCode } from "./SyntaxCode";
import { MermaidDiagram } from "./MermaidDiagram";
import { CopySourceButton } from "./CopySourceButton";
import { TicketReference } from "@/features/tickets/TicketMarkdown";
import { references } from "@/features/tickets/ticket-references";
import {
  MENTION_BLOCKS,
  isMentionBlock,
  type MentionSpan,
  type PositionedNode,
} from "@/features/tickets/mention-passage";

const MarkdownSource = createContext("");
type MdNode = { type: string; value?: string; children?: MdNode[] };
/**
 * Raw HTML is never rendered, but it is not dropped either: `<tag>` written in a brief
 * or Document reads as the literal text the person typed.
 */
function htmlAsText() {
  const walk = (parent: MdNode) => {
    if (!parent.children) return;
    parent.children = parent.children.map((child) => {
      if (child.type !== "html") {
        walk(child);
        return child;
      }
      const text: MdNode = { type: "text", value: child.value ?? "" };
      return parent.type === "paragraph" ||
        parent.type === "heading" ||
        parent.type === "tableCell"
        ? text
        : { type: "paragraph", children: [text] };
    });
  };
  return (tree: MdNode) => walk(tree);
}
const remarkPlugins = [remarkGfm, references, htmlAsText];
/** The passage to mark, and the element that describes it to assistive technology. */
type MentionMark = MentionSpan & { describedBy: string };
const MentionTarget = createContext<MentionMark | null>(null);
const TicketNavigation = createContext<{
  select: ((reference: string) => void) | undefined;
  revision: number | undefined;
}>({ select: undefined, revision: undefined });

/** Says so when a linked Document is in the Trash, as a linked ticket does. */
function TrashedMark({
  id,
  revision,
}: {
  id: string;
  revision: number | undefined;
}) {
  const [trashed, setTrashed] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve(documents.show(id)).then(
      (document) => {
        if (active) setTrashed(document?.trashed === true);
      },
      () => {
        if (active) setTrashed(false);
      },
    );
    return () => {
      active = false;
    };
  }, [id, revision]);
  return trashed ? <> (Trash)</> : null;
}

function DocumentLink({
  href,
  children,
}: {
  href?: string | undefined;
  children?: React.ReactNode;
}) {
  const { select, revision } = useContext(TicketNavigation);
  const openDocument = useContext(DocumentNavigation);
  const openPlan = useContext(PlanNavigation);
  if (href?.startsWith("ticketd://plan/")) {
    const id = href.slice("ticketd://plan/".length);
    return openPlan ? (
      <button
        type="button"
        className="context-link"
        onClick={() => openPlan(id)}
      >
        {children}
      </button>
    ) : (
      <>{children}</>
    );
  }
  if (href?.startsWith("ticketd://document/")) {
    const id = href.slice("ticketd://document/".length);
    return openDocument ? (
      <button
        type="button"
        className="context-link"
        onClick={() => openDocument(id)}
      >
        {children}
        <TrashedMark id={id} revision={revision} />
      </button>
    ) : (
      <>{children}</>
    );
  }
  if (href?.startsWith("ticketd://ticket/"))
    return select ? (
      <TicketReference
        reference={href.slice("ticketd://ticket/".length)}
        select={select}
        revision={revision}
      />
    ) : (
      <>{children}</>
    );
  if (href?.startsWith("ticketd:"))
    return select ? (
      <TicketReference
        reference={href.slice(8)}
        select={select}
        revision={revision}
      />
    ) : (
      <>{children}</>
    );
  return href ? (
    <ExternalLink href={href}>{children}</ExternalLink>
  ) : (
    <span>{children}</span>
  );
}

/**
 * A link in Markdown, including text written at a source such as GitHub. The app
 * window never navigates: an https link opens in the default browser, and any
 * other address does nothing, so a link in someone else's text cannot replace the app.
 */
function ExternalLink({
  href,
  children,
}: {
  href: string;
  children?: React.ReactNode;
}) {
  const [error, setError] = useState("");
  return (
    <>
      <a
        href={href}
        rel="noreferrer"
        onClick={(event) => {
          event.preventDefault();
          if (!href.startsWith("https://")) return;
          workspaceClient.openLink(href).then(
            () => setError(""),
            (reason: unknown) =>
              setError(`Could not open the link: ${String(reason)}`),
          );
        }}
      >
        {children}
      </a>
      {error && <small role="alert">{error}</small>}
    </>
  );
}

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

// The block holding the mention gets its mark as props, so React owns it and
// every other attribute (a code block's tab stop included) stays untouched.
function mentionBlock(tag: string) {
  return function MentionBlock({
    node,
    children,
    ...props
  }: Record<string, unknown> & ExtraProps) {
    const mark = useContext(MentionTarget);
    const marked =
      mark !== null && isMentionBlock(node as PositionedNode, mark);
    return createElement(
      tag,
      marked
        ? {
            ...props,
            "data-mention-target": "",
            tabIndex: -1,
            "aria-describedby": mark.describedBy,
          }
        : props,
      children as React.ReactNode,
    );
  };
}

// React treats each component function as a type. Recreating these functions
// during workspace polling would remount diagrams and discard their SVG/state.
const components: Components = {
  a: DocumentLink,
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
  ...Object.fromEntries(
    [...MENTION_BLOCKS].map((tag) => [tag, mentionBlock(tag)]),
  ),
};

export function MarkdownDocument({
  source,
  select,
  revision,
  mention,
}: {
  source: string;
  select?: ((reference: string) => void) | undefined;
  revision?: number | undefined;
  /** A passage to mark: highlighted, focusable and described. */
  mention?: MentionMark | undefined;
}) {
  return (
    <div className="markdown-document">
      <TicketNavigation.Provider value={{ select, revision }}>
        <MentionTarget.Provider value={mention ?? null}>
          <MarkdownSource.Provider value={source}>
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              urlTransform={(url) =>
                url.startsWith("ticketd:") ? url : defaultUrlTransform(url)
              }
              components={components}
            >
              {source}
            </ReactMarkdown>
          </MarkdownSource.Provider>
        </MentionTarget.Provider>
      </TicketNavigation.Provider>
    </div>
  );
}

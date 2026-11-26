import {
  Children,
  isValidElement,
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  useLayoutEffect,
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
import { writeClipboard } from "@/lib/clipboard";
import { useStatusLine } from "@/components/ui/use-status-line";
import { RecordLink } from "@/components/ui/record-link";
import { SyntaxCode } from "./SyntaxCode";
import { codeLanguageLabel } from "./code-language";
import { chunkFade } from "./chunk-fade";
import { MermaidDiagram } from "./MermaidDiagram";
import { AttachmentLink } from "@/features/attachments/AttachmentLink";
import { AttachmentCardLink } from "./AttachmentCardLink";
import { cardGaps, cardLinks } from "./attachment-cards";
import { attachmentOrder, type PlaceMentions } from "./attachment-order";
import { AttachmentPlace } from "@/features/attachments/attachment-place";
import { CopyButton } from "@/components/ui/copy-button";
import { Check } from "lucide-react";
import { AttachmentImage as InlineAttachmentImage } from "./InlineImage";
import { BlockHeader } from "./BlockHeader";
import type { ReferenceReplacement } from "@/features/attachments/AttachmentPreview";
import { attachments, type Attachment } from "@/lib/api/attachments";
import { useDraftRecovery } from "@/lib/draft-recovery-context";
import { TicketReference } from "@/features/tickets/TicketMarkdown";
import { references } from "@/features/tickets/ticket-references";
import {
  MENTION_BLOCKS,
  isMentionBlock,
  type MentionSpan,
  type PositionedNode,
} from "@/features/tickets/mention-passage";

const MarkdownSource = createContext("");
/** Saved updates show an attachment link alone on its line as a card. */
const AttachmentCards = createContext(false);
const AttachmentReplacement = createContext<
  (node: ExtraProps["node"], uri: string) => ReferenceReplacement | undefined
>(() => undefined);
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
const urlTransform = (url: string) =>
  url.startsWith("ticketd:") ? url : defaultUrlTransform(url);
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
  node,
}: {
  href?: string | undefined;
  children?: React.ReactNode;
} & ExtraProps) {
  const { select, revision } = useContext(TicketNavigation);
  const openDocument = useContext(DocumentNavigation);
  const openPlan = useContext(PlanNavigation);
  const replacement = useContext(AttachmentReplacement);
  const glyph = useContext(AttachmentCards);
  if (href?.startsWith("ticketd://attachment/"))
    return (
      <AttachmentLink
        uri={href}
        onReplace={replacement(node, href)}
        glyph={glyph}
      >
        {children}
      </AttachmentLink>
    );
  if (href?.startsWith("ticketd://plan/")) {
    const id = href.slice("ticketd://plan/".length);
    return openPlan ? (
      <RecordLink onClick={() => openPlan(id)}>{children}</RecordLink>
    ) : (
      <>{children}</>
    );
  }
  if (href?.startsWith("ticketd://document/")) {
    const id = href.slice("ticketd://document/".length);
    return openDocument ? (
      <RecordLink onClick={() => openDocument(id)}>
        {children}
        <TrashedMark id={id} revision={revision} />
      </RecordLink>
    ) : (
      <>{children}</>
    );
  }
  if (href?.startsWith("ticketd://ticket/"))
    return select ? (
      <TicketReference
        reference={href.slice("ticketd://ticket/".length)}
        select={select}
      />
    ) : (
      <>{children}</>
    );
  if (href?.startsWith("ticketd:"))
    return select ? (
      <TicketReference reference={href.slice(8)} select={select} />
    ) : (
      <>{children}</>
    );
  return href ? (
    <ExternalLink href={href}>{children}</ExternalLink>
  ) : (
    <span>{children}</span>
  );
}

/** The host a link points at, for "Couldn't open example.com". */
function linkHost(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
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
  // A failure is an outcome, not part of the text: it goes to the pane's
  // status line instead of being inserted after the link (detA MK, P8).
  const statusLine = useStatusLine();
  return (
    <a
      href={href}
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        if (!href.startsWith("https://")) return;
        workspaceClient.openLink(href).catch(() =>
          statusLine.show({
            tone: "error",
            message: `Couldn't open ${linkHost(href)}`,
            action: {
              label: "Copy link",
              run: async () => {
                const failure = await writeClipboard(href);
                if (failure !== null) throw new Error(failure);
              },
            },
          }),
        );
      }}
    >
      {children}
    </a>
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
      <BlockHeader label={codeLanguageLabel(language) || "Code"}>
        <CopyButton label="Copy code" text={content} size="icon-card" />
      </BlockHeader>
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
    const replacement = useContext(AttachmentReplacement);
    const cards = useContext(AttachmentCards);
    const marked =
      mark !== null && isMentionBlock(node as PositionedNode, mark);
    const alone =
      cards && (tag === "p" || tag === "li") ? cardLinks(node) : null;
    // A card is a block: it cannot sit inside a paragraph, so its row is a div.
    return createElement(
      alone && tag === "p" ? "div" : tag,
      {
        ...(marked
          ? {
              ...props,
              "data-mention-target": "",
              tabIndex: -1,
              "aria-describedby": mark.describedBy,
            }
          : props),
        ...(alone && { "data-cards": "" }),
      },
      alone
        ? alone.map((link, index) => (
            <AttachmentCardLink
              key={`${index}:${link.uri}`}
              uri={link.uri}
              label={link.label}
              onReplace={replacement(link.node as ExtraProps["node"], link.uri)}
            />
          ))
        : tag === "li" &&
            String(props.className ?? "").includes("task-list-item")
          ? Children.map(children as React.ReactNode, (child) => {
              const name = isValidElement<{ node?: ExtraProps["node"] }>(child)
                ? typeof child.type === "string"
                  ? child.type
                  : child.props.node?.tagName
                : undefined;
              // A child list has its own checked state; loose paragraphs already
              // provide a block to decorate without striking the child list.
              return name && ["ul", "ol", "p", "input"].includes(name) ? (
                child
              ) : (
                <span className="markdown-task-text">{child}</span>
              );
            })
          : (children as React.ReactNode),
    );
  };
}

// React treats each component function as a type. Recreating these functions
// during workspace polling would remount diagrams and discard their SVG/state.
const components: Components = {
  a: DocumentLink,
  img: AttachmentImage,
  input: CheckGlyph,
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

function AttachmentImage({
  src,
  alt,
  node,
}: { src?: string | undefined; alt?: string | undefined } & ExtraProps) {
  const replacement = useContext(AttachmentReplacement);
  return src?.startsWith("ticketd://attachment/") ? (
    <InlineAttachmentImage
      uri={src}
      alt={alt ?? ""}
      onReplace={replacement(node, src)}
    />
  ) : (
    <img src={src} alt={alt ?? ""} />
  );
}

/**
 * A read-only checklist box: a drawn glyph, a tick on the recessed fill when
 * done and a ring when not, never a disabled-looking control (detA DS-08).
 */
function CheckGlyph({
  type,
  checked,
}: { type?: string | undefined; checked?: boolean | undefined } & ExtraProps) {
  if (type !== "checkbox") return null;
  return (
    <span
      className="markdown-check"
      data-checked={checked ? "" : undefined}
      role="img"
      aria-label={checked ? "Done" : "Not done"}
    >
      <Check aria-hidden="true" />
    </span>
  );
}

// Replace only this occurrence. Shared reference definitions and other uses stay unchanged.
function replaceDestination(
  occurrence: string,
  oldUri: string,
  nextUri: string,
): string {
  if (occurrence === `<${oldUri}>`) return `[${oldUri}](${nextUri})`;
  let depth = 0;
  for (
    let index = occurrence.startsWith("!") ? 1 : 0;
    index < occurrence.length;
    index++
  ) {
    if (occurrence[index] === "\\") {
      index += 1;
      continue;
    }
    if (occurrence[index] === "`") {
      const ticks = /^`+/.exec(occurrence.slice(index))?.[0] ?? "`";
      let close = occurrence.indexOf(ticks, index + ticks.length);
      while (
        close >= 0 &&
        (occurrence[close - 1] === "`" ||
          occurrence[close + ticks.length] === "`")
      )
        close = occurrence.indexOf(ticks, close + ticks.length);
      if (close >= 0) {
        index = close + ticks.length - 1;
        continue;
      }
    }
    if (occurrence[index] === "[") depth += 1;
    if (occurrence[index] !== "]" || --depth !== 0) continue;
    const label = occurrence.slice(0, index + 1);
    const tail = occurrence.slice(index + 1);
    const destination = /^\(\s*<?/.exec(tail);
    if (destination && tail.slice(destination[0].length).startsWith(oldUri)) {
      const offset = index + 1 + destination[0].length;
      return (
        occurrence.slice(0, offset) +
        nextUri +
        occurrence.slice(offset + oldUri.length)
      );
    }
    if (!tail || tail.startsWith("[")) return `${label}(${nextUri})`;
    break;
  }
  throw new Error(
    "This reference could not be selected safely. Edit its Markdown source to replace it.",
  );
}

export function MarkdownDocument({
  source,
  select,
  revision,
  mention,
  onChange,
  chunkStarts,
  attachmentCards = false,
}: {
  source: string;
  select?: ((reference: string) => void) | undefined;
  revision?: number | undefined;
  /** A passage to mark: highlighted, focusable and described. */
  mention?: MentionMark | undefined;
  onChange?:
    ((source: string, signal: AbortSignal) => void | Promise<void>) | undefined;
  /** Streamed text: source offsets where each newly arrived chunk began; each fades in. */
  chunkStarts?: readonly number[] | undefined;
  /** Show an attachment link that stands alone on its line as a card. */
  attachmentCards?: boolean | undefined;
}) {
  const currentSource = useRef(source);
  const recovery = useDraftRecovery();
  const replacementHistory = useRef<string | null>(null);
  useEffect(
    () => () => {
      const owner = replacementHistory.current;
      if (owner) void recovery.put(owner, null, []).catch(() => {});
    },
    [recovery],
  );
  useLayoutEffect(() => {
    currentSource.current = source;
  }, [source]);
  function replacement(node: ExtraProps["node"], uri: string) {
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    if (!onChange || start === undefined || end === undefined) return undefined;
    return async (
      file: Attachment,
      _requestId: string,
      signal: AbortSignal,
    ) => {
      const nextUri = await attachments.uri(file.id);
      signal.throwIfAborted();
      replacementHistory.current ??= `undo:attachment-replacement:${crypto.randomUUID()}`;
      await recovery.put(
        replacementHistory.current,
        null,
        [source, `[File](${nextUri})`],
        "undo",
      );
      signal.throwIfAborted();
      if (currentSource.current !== source)
        throw new Error(
          "The content changed while choosing a replacement. Close the preview and select the reference again.",
        );
      await onChange(
        source.slice(0, start) +
          replaceDestination(source.slice(start, end), uri, nextUri) +
          source.slice(end),
        signal,
      );
    };
  }
  // The files this text links or shows, in reading order, noted while it parses.
  const [mentions] = useState<PlaceMentions>(() => ({ current: [] }));
  const place = () =>
    mentions.current.map(({ uri, node }) => ({
      uri,
      replace: replacement(node, uri),
    }));
  // Parsing is the cost (about 70 ms at 50 kB): cache the text and fade marks.
  // What a block needs besides its text reaches it through the providers below.
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={
          chunkStarts?.length
            ? [...remarkPlugins, [chunkFade, chunkStarts]]
            : remarkPlugins
        }
        rehypePlugins={
          attachmentCards
            ? [[attachmentOrder, mentions], cardGaps]
            : [[attachmentOrder, mentions]]
        }
        urlTransform={urlTransform}
        components={components}
      >
        {source}
      </ReactMarkdown>
    ),
    [source, chunkStarts, mentions, attachmentCards],
  );
  return (
    <div className="markdown-document">
      <TicketNavigation.Provider value={{ select, revision }}>
        <MentionTarget.Provider value={mention ?? null}>
          <MarkdownSource.Provider value={source}>
            <AttachmentReplacement.Provider value={replacement}>
              <AttachmentCards.Provider value={attachmentCards}>
                <AttachmentPlace.Provider value={place}>
                  {rendered}
                </AttachmentPlace.Provider>
              </AttachmentCards.Provider>
            </AttachmentReplacement.Provider>
          </MarkdownSource.Provider>
        </MentionTarget.Provider>
      </TicketNavigation.Provider>
    </div>
  );
}

import { CopyButton } from "@/components/ui/copy-button";
import { Button } from "@/components/ui/button";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useContext,
  createContext,
  useCallback,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Prec } from "@codemirror/state";
import {
  HighlightStyle,
  LanguageSupport,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { commonmarkLanguage } from "@codemirror/lang-markdown";
import { EditorView, keymap } from "@codemirror/view";
import { RangeApi, TextApi, NodeApi, type Value } from "platejs";
import {
  Plate,
  PlateContent,
  PlateElement,
  PlateLeaf,
  createPlatePlugin,
  usePlateEditor,
  useEditorRef,
  useEditorReadOnly,
  useEditorSelector,
  type PlateElementProps,
  type PlateLeafProps,
  type PlateEditor,
} from "platejs/react";
import {
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  H5Plugin,
  H6Plugin,
  BlockquotePlugin,
  HorizontalRulePlugin,
  BoldPlugin,
  ItalicPlugin,
  CodePlugin,
  StrikethroughPlugin,
} from "@platejs/basic-nodes/react";
import {
  HeadingRules,
  BlockquoteRules,
  BoldRules,
  ItalicRules,
  CodeRules,
  StrikethroughRules,
} from "@platejs/basic-nodes";
import { ListPlugin } from "@platejs/list-classic/react";
import {
  indentListItems,
  unindentListItems,
  BulletedListRules,
  OrderedListRules,
} from "@platejs/list-classic";
import { TablePlugin } from "@platejs/table/react";
import {
  insertTable,
  insertTableRow,
  insertTableColumn,
  deleteRow,
  deleteColumn,
} from "@platejs/table";
import { documents } from "@/features/documents/api";
import { DocumentPicker } from "@/features/tickets/DocumentPicker";
import { AttachmentPicker } from "@/features/attachments/AttachmentPicker";
import {
  AttachmentPreview,
  type ReferenceReplacement,
} from "@/features/attachments/AttachmentPreview";
import {
  useDraftRecovery,
  useDraftRecoveryError,
} from "@/lib/draft-recovery-context";
import {
  attachments,
  type Attachment,
  type CaptureSource,
} from "@/lib/api/attachments";
import { useNativeFileDrop } from "@/features/attachments/use-native-file-drop";
import { useMarkdownExport } from "@/features/attachments/use-markdown-export";
import type { MarkdownExportSource } from "@/lib/api/portable-export";
import { upsertLink } from "@platejs/link";
import { LinkPlugin } from "@platejs/link/react";
import { toggleCodeBlock } from "@platejs/code-block";
import { CodeBlockPlugin } from "@platejs/code-block/react";
import { codeLanguageLabel, codeLowlight } from "./syntax-highlighting";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStatusLine } from "@/components/ui/use-status-line";
import { writeClipboard } from "@/lib/clipboard";
import {
  Bold as BoldIcon,
  Code,
  Italic as ItalicIcon,
  Link,
  List,
  ListChecks,
  ListOrdered,
  MoreHorizontal,
  FileCode2,
  Paperclip,
  Eye,
  Heading1,
  Heading2,
  Heading3,
  Pilcrow,
  Quote,
  SquareCode,
  Minus,
  Table,
  Workflow,
  Strikethrough,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MermaidDiagram } from "./MermaidDiagram";
import { BlockHeader } from "./BlockHeader";
import { EditorImage } from "./InlineImage";
import {
  checklistRule,
  closeCodeFence,
  markdownLinkRule,
  openFenceRule,
} from "./input-rules";
import { linkPluginOptions } from "./link-options";
import { slashChoices, slashMayOpen } from "./slash-menu";
import { applyExternalValue } from "./external-value";
import { codeBlockText, readMarkdown, writeMarkdown } from "./plate-markdown";
import "./markdown-editor.css";
const AttachmentProtection = createContext<(uri: string) => Promise<void>>(
  async () => {},
);

// Source colours come from the --syntax-* tokens, so light and dark each get their
// own palette (CodeMirror's default style is light only). Headings are not underlined:
// only links look like links.
const sourceHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--syntax-title)", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--link-foreground)" },
  { tag: tags.labelName, color: "var(--syntax-keyword)" },
  { tag: [tags.monospace, tags.string], color: "var(--syntax-string)" },
  { tag: [tags.escape, tags.character], color: "var(--syntax-number)" },
  {
    tag: [
      tags.processingInstruction,
      tags.comment,
      tags.contentSeparator,
      tags.quote,
    ],
    color: "var(--syntax-comment)",
  },
]);

// Source mode keeps what is typed: Enter inserts a plain newline, so list markers are not
// doubled and a closing fence never inherits indentation.
const sourceExtensions = [
  // CommonMark alone: markdown()'s defaults add the HTML, CSS and JS parsers.
  new LanguageSupport(commonmarkLanguage),
  syntaxHighlighting(sourceHighlight),
  EditorView.lineWrapping,
  Prec.highest(
    keymap.of([
      {
        key: "Enter",
        run: (view) => {
          view.dispatch(view.state.replaceSelection("\n"), {
            scrollIntoView: true,
            userEvent: "input",
          });
          return true;
        },
      },
    ]),
  ),
];

/** The icon each block in the slash menu wears (P3: every row has one). */
const blockIcons: Record<string, LucideIcon> = {
  p: Pilcrow,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  ul: List,
  ol: ListOrdered,
  task: ListChecks,
  blockquote: Quote,
  code_block: SquareCode,
  hr: Minus,
  table: Table,
  mermaid: Workflow,
};

const CODE_LANGUAGES = [
  "typescript",
  "javascript",
  "json",
  "rust",
  "python",
  "bash",
  "sql",
  "html",
  "css",
  "markdown",
];

function CodeSyntaxLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf {...props} className={String(props.leaf.className ?? "")} />
  );
}

function Leaf(props: PlateLeafProps) {
  let children = props.children;
  if (props.leaf.bold) children = <strong>{children}</strong>;
  if (props.leaf.italic) children = <em>{children}</em>;
  if (props.leaf.strikethrough) children = <s>{children}</s>;
  if (props.leaf.code) children = <code>{children}</code>;
  return <PlateLeaf {...props}>{children}</PlateLeaf>;
}

function Element(props: PlateElementProps) {
  const { element, children } = props;
  const editor = useEditorRef();
  const readOnly = useEditorReadOnly();
  const protectAttachment = useContext(AttachmentProtection);
  const path = editor.api.findPath(element);
  const [preview, setPreview] = useState<{
    uri: string;
    replace: ReferenceReplacement | undefined;
  } | null>(null);
  const tags = {
    p: "p",
    h1: "h1",
    h2: "h2",
    h3: "h3",
    h4: "h4",
    h5: "h5",
    h6: "h6",
    blockquote: "blockquote",
    ul: "ul",
    taskList: "ul",
    ol: "ol",
    li: "li",
    lic: "div",
    code_line: "div",
    tr: "tr",
    td: "td",
    th: "th",
    hr: "div",
    a: "a",
    br: "span",
    img: "span",
  } as const;
  const tag = tags[element.type as keyof typeof tags] ?? "div";
  if (element.type === "table")
    return (
      <div className="markdown-table-scroll">
        <PlateElement {...props} as="table">
          <tbody>{children}</tbody>
        </PlateElement>
      </div>
    );
  if (element.type === "br")
    return (
      <PlateElement {...props} as="span">
        <span contentEditable={false}>
          <br />
        </span>
        {children}
      </PlateElement>
    );
  if (element.type === "img")
    // One unit of the text: the picture (or its label), never editable inside.
    return (
      <PlateElement {...props} as="span" className="editor-image">
        <span contentEditable={false}>
          <EditorImage
            url={String(element.url ?? "")}
            alt={String(element.alt ?? "")}
          />
        </span>
        {children}
      </PlateElement>
    );
  return (
    <PlateElement
      {...props}
      as={tag}
      attributes={{
        ...props.attributes,
        ...(element.type === "a"
          ? {
              href: /^(https?:|mailto:|\/|#)/i.test(String(element.url))
                ? String(element.url)
                : undefined,
              onClick: (event: MouseEvent) => event.preventDefault(),
            }
          : {}),
        ...(element.type === "ol" ? { start: Number(element.start ?? 1) } : {}),
      }}
    >
      {element.type === "li" && typeof element.checked === "boolean" && (
        <input
          type="checkbox"
          aria-label="Checklist item"
          contentEditable={false}
          checked={element.checked}
          disabled={readOnly}
          onChange={(event) =>
            path &&
            editor.tf.setNodes({ checked: event.target.checked }, { at: path })
          }
        />
      )}
      {element.type === "hr" && (
        <span contentEditable={false} className="editor-rule" />
      )}
      {children}
      {element.type === "a" &&
        String(element.url).startsWith("ticketd://attachment/") && (
          <span contentEditable={false}>
            <Tooltip content="Preview attachment">
              <button
                type="button"
                className="attachment-inline-preview"
                aria-label={`Preview attachment: ${NodeApi.string(element)}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const before = writeMarkdown(editor.children);
                  setPreview({
                    uri: String(element.url),
                    replace:
                      readOnly || !path
                        ? undefined
                        : async (file, _requestId, signal) => {
                            const uri = await attachments.uri(file.id);
                            signal.throwIfAborted();
                            await protectAttachment(uri);
                            signal.throwIfAborted();
                            if (writeMarkdown(editor.children) !== before)
                              throw new Error(
                                "The content changed while choosing a replacement. Close the preview and select the reference again.",
                              );
                            editor.tf.setNodes({ url: uri }, { at: path });
                          },
                  });
                }}
              >
                <Eye aria-hidden="true" />
              </button>
            </Tooltip>
            {preview && (
              <AttachmentPreview
                target={{ uri: preview.uri }}
                onClose={() => setPreview(null)}
                onReplace={preview.replace}
              />
            )}
          </span>
        )}
    </PlateElement>
  );
}

/**
 * A code block in the editor: the same BlockHeader as reading, its language
 * field always in the header, so the code never moves when the caret enters
 * (detA MK-08).
 */
function CodeFence(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useEditorReadOnly();
  const languageId = useId();
  return (
    <PlateElement {...props} as="div" className="markdown-code-block">
      <BlockHeader
        label={
          <input
            aria-label="Code language"
            className="code-language"
            list={`${languageId}-languages`}
            value={codeLanguageLabel(String(props.element.lang ?? ""))}
            placeholder="Plain text"
            readOnly={readOnly}
            onChange={(event) => {
              const lang = event.target.value;
              const path = editor.api.findPath(props.element);
              // Fence info strings accept a single language token; metadata
              // stays available through the document's Markdown source editor.
              if (!readOnly && path && !/[\s`~]/.test(lang))
                editor.tf.setNodes({ lang }, { at: path });
            }}
          />
        }
      >
        <CopyButton
          label="Copy code"
          text={`${codeBlockText(props.element)}\n`}
          size="icon-card"
          onMouseDown={(event) => event.preventDefault()}
        />
      </BlockHeader>
      <datalist id={`${languageId}-languages`}>
        {CODE_LANGUAGES.map((lang) => (
          <option key={lang} value={lang} />
        ))}
      </datalist>
      <pre>{props.children}</pre>
    </PlateElement>
  );
}

/** A Mermaid block keeps its preview while editing; its source opens beneath. */
function Diagram(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useEditorReadOnly();
  const source = String(props.element.source ?? "");
  const labels = diagramLabels(source);
  // The source editor mounts only while open: a closed one costs nothing.
  const [sourceOpen, setSourceOpen] = useState(false);
  return (
    <PlateElement {...props}>
      <div contentEditable={false} className="diagram-editor">
        <MermaidDiagram source={source} />
        <Disclosure
          label={labels ? `Source · ${labels}` : "Source"}
          open={sourceOpen}
          onOpenChange={setSourceOpen}
        >
          {sourceOpen && (
            <CodeMirror
              value={source}
              readOnly={readOnly}
              editable={!readOnly}
              aria-label="Mermaid source"
              theme="none"
              extensions={sourceExtensions}
              onChange={(next) => {
                const path = editor.api.findPath(props.element);
                if (!readOnly && path && next !== source)
                  editor.tf.setNodes({ source: next }, { at: path });
              }}
            />
          )}
        </Disclosure>
      </div>
      {props.children}
    </PlateElement>
  );
}

function moveBlock(editor: PlateEditor, direction: number) {
  const index = editor.selection?.anchor.path[0];
  if (
    index === undefined ||
    index + direction < 0 ||
    index + direction >= editor.children.length
  )
    return;
  editor.tf.moveNodes({ at: [index], to: [index + direction] });
  editor.tf.focus();
}

function textBeforeCaret(editor: PlateEditor) {
  const selection = editor.selection;
  if (!selection) return "";
  if (!editor.api.isCollapsed()) return null;
  const block = editor.api.block();
  if (!block) return "";
  const anchor = editor.api.start(block[1]);
  return anchor ? editor.api.string({ anchor, focus: selection.anchor }) : "";
}

function insert(editor: PlateEditor, type: string) {
  editor.tf.focus();
  if (type === "table") {
    insertTable(editor, { rowCount: 3, colCount: 2 });
    return;
  }
  if (type === "ul") {
    editor.getTransforms(ListPlugin).toggle.bulletedList();
    return;
  }
  if (type === "ol") {
    editor.getTransforms(ListPlugin).toggle.numberedList();
    return;
  }
  if (type === "task") {
    editor.getTransforms(ListPlugin).toggle.taskList();
    return;
  }
  if (type === "hr") {
    editor.tf.insertNodes([
      { type: "hr", children: [{ text: "" }] },
      { type: "p", children: [{ text: "" }] },
    ]);
    return;
  }
  if (type === "mermaid") {
    editor.tf.insertNodes([
      {
        type: "mermaid",
        source: "graph TD\n  A --> B\n",
        children: [{ text: "" }],
      },
      { type: "p", children: [{ text: "" }] },
    ]);
    return;
  }
  if (type === "code_block") {
    toggleCodeBlock(editor);
    return;
  }
  editor.tf.setNodes(
    { type },
    { match: (node) => !TextApi.isText(node) && editor.api.isBlock(node) },
  );
}

/** A heading toggles back to a paragraph, so one button both makes and undoes it. */
function toggleHeading(editor: PlateEditor) {
  insert(editor, editor.api.some({ match: { type: "h2" } }) ? "p" : "h2");
}

/** Where the caret is on screen, for an overlay that opens at it. */
function caretRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const rect =
    typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : null;
  if (rect && (rect.width || rect.height)) return rect;
  // An empty block has no text to measure: use the block itself.
  const node = range.startContainer;
  const element =
    node instanceof globalThis.Element ? node : node.parentElement;
  return element?.getBoundingClientRect() ?? null;
}

const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * The link form: pick a Document by title, or type an address. Enter applies;
 * a collapsed selection gets the Document's heading as its text.
 */
function LinkForm({ onDone }: { onDone: () => void }) {
  const editor = useEditorRef();
  const [url, setUrl] = useState("");
  const urlId = useId();
  return (
    <div className="editor-link-form">
      <DocumentPicker
        autoFocus
        onPick={(picked) => {
          const collapsed = !editor.selection || editor.api.isCollapsed();
          upsertLink(editor, {
            url: `ticketd://document/${picked.id}`,
            ...(collapsed ? { text: picked.heading } : {}),
          });
          onDone();
          editor.tf.focus();
        }}
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const target = url.trim();
          if (!/^(https?:|mailto:|ticketd:\/\/|\/|#)/i.test(target)) return;
          const collapsed = !editor.selection || editor.api.isCollapsed();
          const documentId = /^ticketd:\/\/document\/([^/?#\s]+)$/i.exec(
            target,
          )?.[1];
          // A typed Document link reads as the Document's heading, not its raw URL.
          void (async () => {
            let text: string | undefined;
            if (collapsed && documentId)
              text = await documents
                .show(documentId)
                .then((doc) => doc.heading)
                .catch(() => undefined);
            upsertLink(editor, { url: target, ...(text ? { text } : {}) });
            setUrl("");
            onDone();
            editor.tf.focus();
          })();
        }}
      >
        <Field>
          <FieldLabel htmlFor={urlId}>Or link an address</FieldLabel>
          <Input
            id={urlId}
            placeholder="e.g. https://example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
      </form>
    </div>
  );
}

/** Link as an icon button that opens the link form under it. */
function LinkButton({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <IconButton
          type="button"
          label="Link"
          shortcut="⌘K"
          onMouseDown={keepFocus}
        >
          <Link />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Link">
        <LinkForm onDone={() => onOpenChange(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The formatting part of the session row (P16): the essentials as icon
 * buttons with tooltips, and the rest in "…" with their keys. Insertions live
 * in the slash menu only.
 */
function SessionFormatting({
  onAttach,
  floating = false,
  more,
  onMenuOpenChange,
}: {
  onAttach: () => void;
  floating?: boolean;
  /** The "…" menu opened or closed (Export reads the selection then). */
  onMenuOpenChange: (open: boolean) => void;
  /** Copy Markdown and Export: the last group of "…". */
  more: ReactNode;
}) {
  const editor = useEditorRef();
  const [linkOpen, setLinkOpen] = useState(false);
  const inTable = useEditorSelector(
    (current) => current.api.some({ match: { type: "table" } }),
    [],
  );
  const mark = (key: string) => () => {
    editor.tf.toggleMark(key);
    editor.tf.focus();
  };
  return (
    <span className="editor-formatting" role="toolbar" aria-label="Formatting">
      <IconButton
        type="button"
        label="Bold"
        shortcut="⌘B"
        onMouseDown={keepFocus}
        onClick={mark("bold")}
      >
        <BoldIcon />
      </IconButton>
      <IconButton
        type="button"
        label="Italic"
        shortcut="⌘I"
        onMouseDown={keepFocus}
        onClick={mark("italic")}
      >
        <ItalicIcon />
      </IconButton>
      {!floating && (
        <>
          <IconButton
            type="button"
            label="Bullet list"
            onMouseDown={keepFocus}
            onClick={() => insert(editor, "ul")}
          >
            <List />
          </IconButton>
          <IconButton
            type="button"
            label="Checklist"
            onMouseDown={keepFocus}
            onClick={() => insert(editor, "task")}
          >
            <ListChecks />
          </IconButton>
        </>
      )}
      <LinkButton open={linkOpen} onOpenChange={setLinkOpen} />
      {!floating && (
        <>
          <IconButton
            type="button"
            label="Insert attachment"
            onMouseDown={keepFocus}
            onClick={onAttach}
          >
            <Paperclip />
          </IconButton>
        </>
      )}
      <DropdownMenu onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <IconButton
            type="button"
            label="More formatting"
            onMouseDown={keepFocus}
          >
            <MoreHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {floating && (
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => insert(editor, "ul")}>
                <List aria-hidden="true" />
                Bullet list
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => insert(editor, "task")}>
                <ListChecks aria-hidden="true" />
                Checklist
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onAttach}>
                <Paperclip aria-hidden="true" />
                Insert attachment
              </DropdownMenuItem>
            </DropdownMenuGroup>
          )}
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => toggleHeading(editor)}>
              <Heading2 aria-hidden="true" />
              Heading
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={mark("code")}>
              <Code aria-hidden="true" />
              Inline code
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={mark("strikethrough")}>
              <Strikethrough aria-hidden="true" />
              Strikethrough
              <DropdownMenuShortcut>⌘⇧X</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => moveBlock(editor, -1)}>
              Move block up
              <DropdownMenuShortcut>⌥↑</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => moveBlock(editor, 1)}>
              Move block down
              <DropdownMenuShortcut>⌥↓</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {inTable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => insertTableRow(editor)}>
                  Add row
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => insertTableColumn(editor)}>
                  Add column
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => deleteRow(editor)}>
                  Delete row
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => deleteColumn(editor)}>
                  Delete column
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
          <DropdownMenuSeparator />
          {more}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/**
 * Formatting for a quick composer (Activity, Capture, New ticket): a small bar
 * over the selected text, never a docked toolbar. It opens only while text is
 * selected in the focused editor and never takes focus from it.
 */
function SelectionBubble({ focused }: { focused: boolean }) {
  const editor = useEditorRef();
  const [linkOpen, setLinkOpen] = useState(false);
  const expanded = useEditorSelector(
    (current) => !!current.selection && !current.api.isCollapsed(),
    [],
  );
  const selection = useEditorSelector((current) => current.selection, []);
  // Measured when the popper asks, so it always sits on the current selection.
  const last = useRef<DOMRect | null>(null);
  const anchor = useRef({
    getBoundingClientRect: () => {
      const rect = caretRect();
      if (rect) last.current = rect;
      return last.current ?? new DOMRect();
    },
  });
  const open = (focused && expanded) || linkOpen;
  // A new selection places the bar afresh.
  const placement = selection
    ? `${selection.anchor.path.join(".")}:${selection.anchor.offset}-${selection.focus.path.join(".")}:${selection.focus.offset}`
    : "";
  const mark = (key: string) => () => {
    editor.tf.toggleMark(key);
    editor.tf.focus();
  };
  return (
    <Popover open={open}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        key={linkOpen ? "link" : placement}
        variant="bar"
        side="top"
        align="center"
        sideOffset={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <span
          role="toolbar"
          aria-label="Selection formatting"
          className="editor-bubble"
        >
          <IconButton
            type="button"
            label="Bold"
            shortcut="⌘B"
            tooltipSide="top"
            onMouseDown={keepFocus}
            onClick={mark("bold")}
          >
            <BoldIcon />
          </IconButton>
          <IconButton
            type="button"
            label="Italic"
            shortcut="⌘I"
            tooltipSide="top"
            onMouseDown={keepFocus}
            onClick={mark("italic")}
          >
            <ItalicIcon />
          </IconButton>
          <IconButton
            type="button"
            label="Strikethrough"
            tooltipSide="top"
            onMouseDown={keepFocus}
            onClick={mark("strikethrough")}
          >
            <Strikethrough />
          </IconButton>
          <IconButton
            type="button"
            label="Inline code"
            tooltipSide="top"
            onMouseDown={keepFocus}
            onClick={mark("code")}
          >
            <Code />
          </IconButton>
          <LinkButton open={linkOpen} onOpenChange={setLinkOpen} />
        </span>
      </PopoverContent>
    </Popover>
  );
}

/** The slash menu, opened at the caret: every block with its icon. */
function SlashMenu({
  id,
  anchor,
  choices,
  query,
  index,
  onChoose,
  onClose,
}: {
  id: string;
  anchor: DOMRect | null;
  choices: ReturnType<typeof slashChoices>;
  query: string;
  index: number;
  onChoose: (type: string) => void;
  onClose: () => void;
}) {
  const virtual = useMemo(
    () => ({
      current: { getBoundingClientRect: () => anchor ?? new DOMRect() },
    }),
    [anchor],
  );
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverAnchor virtualRef={virtual} />
      <PopoverContent
        variant="compact-list"
        side="bottom"
        align="start"
        onEscapeKeyDown={(event) => {
          // The caret stays in the editor outside this popover. Own Escape at
          // the dismissable layer before closing can expose the editor beneath.
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="editor-caption px-2 py-1">
          Blocks matching “{query}”
        </div>
        <div id={id} role="listbox" aria-label="Insert block">
          {choices.length ? (
            choices.map(([type, title], position) => {
              const Icon = blockIcons[type] ?? Pilcrow;
              return (
                <div
                  key={type}
                  id={`${id}-${type}`}
                  role="option"
                  aria-label={title}
                  aria-selected={position === index}
                  className="slash-option"
                  onMouseDown={keepFocus}
                  onClick={() => onChoose(type)}
                >
                  <Icon aria-hidden="true" />
                  <span className="flex-1">{title}</span>
                  <span className="editor-caption">
                    {
                      (
                        {
                          p: "text",
                          h1: "#",
                          h2: "##",
                          h3: "###",
                          ul: "-",
                          ol: "1.",
                          task: "[]",
                          blockquote: ">",
                          code_block: "```",
                          hr: "---",
                          table: "| |",
                          mermaid: "```mermaid",
                        } as Record<string, string>
                      )[type]
                    }
                  </span>
                </div>
              );
            })
          ) : (
            <div className="slash-empty" role="presentation">
              No matching blocks
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const richPlugins = [
  ...[H1Plugin, H2Plugin, H3Plugin, H4Plugin, H5Plugin, H6Plugin].map(
    (plugin) => plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  ),
  BlockquotePlugin.configure({ inputRules: [BlockquoteRules.markdown()] }),
  HorizontalRulePlugin,
  BoldPlugin.configure({
    inputRules: [BoldRules.markdown(), BoldRules.markdown({ variant: "_" })],
  }),
  ItalicPlugin.configure({
    inputRules: [
      ItalicRules.markdown(),
      ItalicRules.markdown({ variant: "_" }),
    ],
  }),
  CodePlugin.configure({ inputRules: [CodeRules.markdown()] }),
  StrikethroughPlugin.configure({
    inputRules: [StrikethroughRules.markdown()],
  }),
  ListPlugin.configure({
    inputRules: [
      BulletedListRules.markdown(),
      BulletedListRules.markdown({ variant: "*" }),
      OrderedListRules.markdown(),
      checklistRule,
    ],
  }),
  TablePlugin.configure({ options: { disableMerge: true } }),
  LinkPlugin.configure({
    options: linkPluginOptions,
    inputRules: [markdownLinkRule],
  }),
  CodeBlockPlugin.configure({
    options: { lowlight: codeLowlight },
    inputRules: [openFenceRule],
  }),
  createPlatePlugin({
    key: "mermaid",
    node: { isElement: true, isVoid: true, component: Diagram },
  }),
  createPlatePlugin({
    key: "img",
    node: { isElement: true, isInline: true, isVoid: true },
  }),
  createPlatePlugin({
    key: "br",
    node: { isElement: true, isInline: true, isVoid: true },
  }),
];

/** How long typing pauses before rich text is written out as Markdown. */
const IDLE_MS = 250;
/** Continuous typing is still written out at least this often. */
const LONGEST_WAIT_MS = 2000;

/** The attachment links in a text, as written; a test for growth, not a parser. */
function attachmentLinks(text: string) {
  return new Set(text.match(/ticketd:\/\/attachment\/[^\s)>\]"'<]+/gi));
}

/** Whether rich text holds only one empty paragraph. */
function blank(value: Value) {
  const [first] = value;
  return (
    value.length === 1 && first?.type === "p" && NodeApi.string(first) === ""
  );
}

export interface MarkdownEditorProps {
  value: string;
  /**
   * The Markdown, at the editor's own cadence: rich edits once typing pauses
   * (about 250 ms, at most every 2 s) and at once on blur, Escape, a Ctrl/Cmd
   * shortcut, unmount and window close; source edits as typed.
   */
  onChange: (markdown: string) => void;
  /**
   * The editor holds rich edits that `onChange` has not reported yet (true), or
   * has reported them (false). Hosts that refresh from outside changes treat
   * the text as edited meanwhile.
   */
  onPendingChange?: (pending: boolean) => void;
  readOnly?: boolean;
  label?: string;
  autoFocus?: boolean;
  /** Shown while the rich editor is empty, e.g. "Write a thought…". */
  placeholder?: string;
  /** Bump to return focus to the editor at its last caret (e.g. after a conflict action). */
  focusRequest?: number;
  /** With a focus request, put the caret after the first link whose URL contains this text. */
  focusLink?: string;
  /** With a focus request, start an empty paragraph below a trailing quote so typing lands outside it. */
  paragraphAfterQuote?: boolean;
  /**
   * `floating`: in-place editing with controls hosted in FloatingEditBar.
   * `session`: legacy host-row editing. Its
   * formatting row goes into `chromeHost`, the 32px session row its page
   * reserves, so nothing is inserted above the text and nothing toggles with
   * focus. `compact` (quick composers): no toolbar; formatting is the
   * selection bubble and slash, and only Insert attachment and the source
   * switch show, in `chromeHost` (the composer's bottom row) or under the text.
   */
  chrome?: "session" | "compact" | "floating";
  /** Where the editor's controls render; see `chrome`. */
  chromeHost?: HTMLElement | null;
  /** Another field currently owns the shared controls host. */
  controlsHidden?: boolean;
  /** Escape with nothing open inside the editor: finish editing. */
  onEscape?: () => void;
  /** Recovery owner to explain independent Undo protection in attachment usage. */
  recoveryOwner?: string;
  /** Current ticket context ranks related files; it never changes reference ownership. */
  attachmentTicketReference?: string | null | undefined;
}

/** Controlled draft editor. Persistence and external-update decisions belong to its caller. */
export function MarkdownEditor({
  value,
  onChange,
  onPendingChange,
  readOnly = false,
  label = "Markdown document",
  autoFocus = false,
  placeholder,
  focusRequest = 0,
  focusLink,
  paragraphAfterQuote = false,
  chrome = "compact",
  chromeHost,
  controlsHidden = false,
  onEscape,
  recoveryOwner = label,
  attachmentTicketReference = null,
}: MarkdownEditorProps) {
  const recovery = useDraftRecovery();
  // The workspace band reports a failure to protect drafts once for the whole
  // window; the editor only stops saying its content is protected.
  const recoveryError = useDraftRecoveryError();
  const statusLine = useStatusLine();
  const [historyOwner] = useState(
    () => `undo:${recoveryOwner}:${crypto.randomUUID()}`,
  );
  const protectAttachment = useCallback(
    (uri: string) =>
      recovery.put(historyOwner, null, [`[File](${uri})`], "undo"),
    [recovery, historyOwner],
  );
  // Undo can bring back any text this editor held, so its record keeps every
  // attachment link seen (ADR 0009); the core accumulates them. Only a new link
  // needs a write.
  const [historyLinks, setHistoryLinks] = useState<{
    recovery: typeof recovery;
    links: ReadonlySet<string>;
  }>({ recovery, links: new Set() });
  const protectedLinks =
    historyLinks.recovery === recovery ? historyLinks.links : null;
  const valueLinks = useMemo(() => attachmentLinks(value), [value]);
  const linksProtected = [...valueLinks].every((link) =>
    protectedLinks?.has(link),
  );
  useEffect(() => {
    if (linksProtected) return;
    let current = true;
    void recovery
      .put(historyOwner, null, [value], "undo")
      .then(() => {
        if (current)
          setHistoryLinks((previous) => ({
            recovery,
            links: new Set([
              ...(previous.recovery === recovery ? previous.links : []),
              ...valueLinks,
            ]),
          }));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [
    recovery,
    historyOwner,
    value,
    valueLinks,
    linksProtected,
    recoveryError,
  ]);
  useEffect(
    () => () => {
      void recovery.put(historyOwner, null, []).catch(() => {});
    },
    [recovery, historyOwner],
  );
  // Whether the rich text has focus: the selection bubble shows only then.
  const [focused, setFocused] = useState(false);
  const [assessed, setAssessed] = useState<{
    source: string;
    document: Pick<
      ReturnType<typeof readMarkdown>,
      "value" | "reasons" | "markdown"
    >;
  }>(() => ({ source: value, document: readMarkdown(value) }));
  // The text the host holds, as last reported here or given from outside.
  const emitted = useRef(value);
  // Whether the rich text is empty, for the placeholder.
  const [empty, setEmpty] = useState(() => value.trim() === "");
  let document = assessed.document;
  // A value this editor reported is already assessed: rich text as it was
  // written, source typing when typing pauses (see `report`).
  if (assessed.source !== value) {
    document = readMarkdown(value);
    setAssessed({ source: value, document });
    setEmpty(value.trim() === "");
  }
  const [sourceMode, setSourceMode] = useState(false);
  const [slash, setSlash] = useState(false);
  const [slashAnchor, setSlashAnchor] = useState<DOMRect | null>(null);
  const editorId = useId();
  const slashMenuId = `${editorId}-slash-menu`;
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState("");
  const forced = document.reasons.length > 0;
  const source = sourceMode || forced;
  const container = useRef<HTMLElement>(null);
  const sourceEditor = useRef<ReactCodeMirrorRef>(null);
  const sourceEditorExtensions = useMemo(
    () => [
      ...sourceExtensions,
      EditorView.contentAttributes.of({ "aria-label": `${label} source` }),
    ],
    [label],
  );
  const [attachmentPicker, setAttachmentPicker] = useState(false);
  const [capture, setCapture] = useState<{ sources: CaptureSource[] }>();
  const focusAfterInsertion = useRef(false);
  const insertion = useRef<{
    rich: PlateEditor["selection"];
    source: { from: number; to: number } | undefined;
    markdown: string;
    links: Map<string, { uri: string; from: number; to: number }>;
    tail?: string;
  } | null>(null);
  useEffect(
    () => () => {
      insertion.current = null;
    },
    [],
  );
  // The canonical Markdown of the text the host holds: rich text that still
  // writes this has nothing new to report.
  const canonical = useRef(document.markdown);
  // When rich edits not yet reported began, or null.
  const pendingSince = useRef<number | null>(null);
  // Source typing the rich value has not read yet.
  const sourceUnread = useRef(false);
  const idleTimer = useRef<number | undefined>(undefined);
  // Operations that applied the host's value, so they never count as edits.
  const outsideOperations = useRef(new WeakSet<object>());
  const latest = useRef({ onChange, onPendingChange });
  useEffect(() => {
    latest.current = { onChange, onPendingChange };
  });
  const editor = usePlateEditor({
    plugins: richPlugins,
    components: {
      p: Element,
      h1: Element,
      h2: Element,
      h3: Element,
      h4: Element,
      h5: Element,
      h6: Element,
      blockquote: Element,
      ul: Element,
      taskList: Element,
      ol: Element,
      li: Element,
      lic: Element,
      table: Element,
      tr: Element,
      td: Element,
      th: Element,
      a: Element,
      code_block: CodeFence,
      code_line: Element,
      code_syntax: CodeSyntaxLeaf,
      hr: Element,
      br: Element,
      img: Element,
      bold: Leaf,
      italic: Leaf,
      code: Leaf,
      strikethrough: Leaf,
    },
    value: document.value,
  });
  /**
   * Bring the host and the rich value up to date: read pending source typing
   * into the rich value, and report pending rich edits as Markdown. Each
   * converts the whole document once, so it runs when typing pauses or when the
   * text is needed now, never per keystroke.
   */
  const report = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    if (sourceUnread.current) {
      sourceUnread.current = false;
      const parsed = readMarkdown(emitted.current);
      canonical.current = parsed.markdown;
      setAssessed({ source: emitted.current, document: parsed });
      setEmpty(emitted.current.trim() === "");
      editor.tf.setValue(parsed.value);
      for (const operation of editor.operations)
        outsideOperations.current.add(operation);
    }
    if (pendingSince.current === null) return;
    pendingSince.current = null;
    latest.current.onPendingChange?.(false);
    const markdown = writeMarkdown(editor.children);
    if (markdown === canonical.current) return;
    canonical.current = markdown;
    emitted.current = markdown;
    setAssessed({
      source: markdown,
      document: { value: editor.children, reasons: [], markdown },
    });
    latest.current.onChange(markdown);
  }, [editor]);
  /** Report once typing pauses, or once rich edits have waited long enough. */
  const reportWhenIdle = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    const since = pendingSince.current;
    const wait =
      since === null
        ? IDLE_MS
        : Math.max(0, Math.min(IDLE_MS, since + LONGEST_WAIT_MS - Date.now()));
    idleTimer.current = window.setTimeout(report, wait);
  }, [report]);
  // Closing the window or unmounting reports what is pending, so a host's
  // recovery draft has it.
  useEffect(() => {
    const hidden = () => {
      if (globalThis.document.visibilityState === "hidden") report();
    };
    window.addEventListener("beforeunload", report);
    window.addEventListener("pagehide", report);
    window.addEventListener("ticketd:window-closing", report);
    globalThis.document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("beforeunload", report);
      window.removeEventListener("pagehide", report);
      window.removeEventListener("ticketd:window-closing", report);
      globalThis.document.removeEventListener("visibilitychange", hidden);
      report();
    };
  }, [report]);
  useEffect(() => {
    if (!autoFocus || readOnly) return;
    const frame = window.requestAnimationFrame(() => {
      if (source)
        container.current?.querySelector<HTMLElement>(".cm-content")?.focus();
      else {
        editor.tf.focus();
        container.current
          ?.querySelector<HTMLElement>(".rich-document")
          ?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, readOnly, source, editor]);
  // Slate drops its selection when focus leaves, so remember the last caret for outside changes.
  const lastSelection = useRef<PlateEditor["selection"]>(null);
  useEffect(() => {
    if (attachmentPicker || !focusAfterInsertion.current) return;
    focusAfterInsertion.current = false;
    const frame = window.requestAnimationFrame(() => {
      if (source) sourceEditor.current?.view?.focus();
      else editor.tf.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [attachmentPicker, source, editor]);
  function beginAttachment() {
    // Native selection changes can precede Slate's throttled selection update.
    const selection = window.getSelection();
    const rich =
      !source && selection && container.current?.contains(selection.anchorNode)
        ? editor.api.toSlateRange(selection, {
            exactMatch: false,
            suppressThrow: true,
          })
        : null;
    report();
    insertion.current = {
      rich: rich ?? editor.selection ?? lastSelection.current,
      source: sourceEditor.current?.view?.state.selection.main,
      markdown: emitted.current,
      links: new Map(),
    };
    focusAfterInsertion.current = true;
    setAttachmentPicker(true);
  }
  function captureFiles(
    sources: CaptureSource[],
    point?: { x: number; y: number },
  ) {
    if (!sources.length || readOnly) return;
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      if (source) {
        const view = sourceEditor.current?.view;
        const pos = view?.posAtCoords(point);
        if (view && pos !== null && pos !== undefined)
          view.dispatch({ selection: { anchor: pos } });
      } else {
        const range = globalThis.document.caretRangeFromPoint?.(
          point.x,
          point.y,
        );
        if (range && container.current?.contains(range.startContainer)) {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }
    }
    beginAttachment();
    setCapture({ sources });
  }
  const dropFailure = useNativeFileDrop(
    container,
    !readOnly && !attachmentPicker,
    captureFiles,
  );
  async function insertAttachment(
    file: Attachment,
    _requestId: string,
    beforeId?: string,
  ) {
    const pending = insertion.current;
    const uri = await attachments.uri(file.id);
    await recovery.put(historyOwner, null, [`[File](${uri})`], "undo");
    if (!pending || pending !== insertion.current) return;
    report();
    if (pending.markdown !== emitted.current)
      throw new Error(
        "The document changed while choosing a file. Close the picker and choose the insertion point again; the stored file remains available.",
      );
    if (source) {
      const view = sourceEditor.current?.view;
      if (!view)
        throw new Error("Reopen this editor to insert the stored file.");
      const before = beforeId ? pending.links.get(beforeId) : undefined;
      const caret = pending.source ?? view.state.selection.main;
      let from = before?.from ?? caret.from;
      let to = before?.from ?? caret.to;
      if (!before) {
        let node = syntaxTree(view.state).resolveInner(caret.from, -1);
        const linkNodes = ["Link", "Image", "Autolink"];
        while (node.parent && !linkNodes.includes(node.name))
          node = node.parent;
        if (linkNodes.includes(node.name)) from = to = node.to;
      }
      // Source insertion may be inside a GFM table; a filename pipe must stay in its cell.
      const link = writeMarkdown([
        {
          type: "p",
          children: [
            { type: "a", url: uri, children: [{ text: file.display_name }] },
          ],
        },
      ]).replaceAll("|", "\\|");
      view.dispatch({
        changes: { from, to, insert: link },
        selection: { anchor: from + link.length },
      });
      const delta = link.length - (to - from);
      for (const existing of pending.links.values()) {
        if (existing.from >= from) {
          existing.from += delta;
          existing.to += delta;
        }
      }
      pending.links.set(file.id, { uri, from, to: from + link.length });
      pending.source = before
        ? { from: caret.from + delta, to: caret.to + delta }
        : { from: from + link.length, to: from + link.length };
      pending.markdown = view.state.doc.toString();
    } else {
      const anchor = pending.links.get(beforeId ?? pending.tail ?? "");
      const existing =
        anchor &&
        editor.api.node({
          at: [],
          match: (node) => "url" in node && node.url === anchor.uri,
        });
      if (existing) {
        const point = beforeId
          ? editor.api.before(existing[1])
          : editor.api.after(existing[1]);
        if (point) editor.tf.select(point);
      } else {
        if (pending.rich) editor.tf.select(pending.rich);
        else editor.tf.select(editor.api.end([]) ?? [0]);
        const enclosingLink = editor.api.above({ match: { type: "a" } });
        const point = enclosingLink && editor.api.after(enclosingLink[1]);
        if (point) editor.tf.select(point);
      }
      // Insert a link node rather than upserting the surrounding link or replacing its label.
      editor.tf.insertNodes({
        type: "a",
        url: uri,
        children: [{ text: file.display_name }],
      });
      editor.tf.move({ distance: 1, unit: "offset" });
      pending.links.set(file.id, { uri, from: 0, to: 0 });
      pending.rich = editor.selection;
      pending.markdown = writeMarkdown(editor.children);
    }
    if (!beforeId) pending.tail = file.id;
    focusAfterInsertion.current = true;
  }
  useEffect(() => {
    if (!focusRequest || readOnly) return;
    const frame = window.requestAnimationFrame(() => {
      if (source) {
        container.current?.querySelector<HTMLElement>(".cm-content")?.focus();
        return;
      }
      const last = editor.children.at(-1);
      if (paragraphAfterQuote && last && last.type === "blockquote") {
        // Markdown drops a trailing blank paragraph, so the reply caret needs one made here.
        editor.tf.insertNodes(
          { type: "p", children: [{ text: "" }] },
          { at: [editor.children.length] },
        );
        editor.tf.select(editor.api.end([]) ?? [editor.children.length - 1]);
      } else if (focusLink) {
        const found = editor.api.node({
          at: [],
          match: (node) =>
            "type" in node &&
            node.type === "a" &&
            String((node as { url?: unknown }).url ?? "").includes(focusLink),
        });
        const end = found && editor.api.end(found[1]);
        if (end) editor.tf.select(end);
      } else if (!editor.selection && lastSelection.current)
        editor.tf.select(lastSelection.current);
      editor.tf.focus();
      container.current?.querySelector<HTMLElement>(".rich-document")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, focusLink, readOnly, source, editor, paragraphAfterQuote]);
  useEffect(() => {
    if (value === emitted.current) return;
    // Typing not reported yet is newer than what the host holds: report it
    // instead of replacing it (hosts learn of it through onPendingChange).
    const reported = emitted.current;
    if (pendingSince.current !== null) report();
    if (emitted.current !== reported) return;
    window.clearTimeout(idleTimer.current);
    sourceUnread.current = false;
    emitted.current = value;
    canonical.current = document.markdown;
    applyExternalValue(editor, document.value, lastSelection.current);
    // Slate reports these with the next change; they are not typing.
    for (const operation of editor.operations)
      outsideOperations.current.add(operation);
  }, [value, document, editor, report]);
  const choices = slashChoices(slashQuery);
  function closeSlash() {
    setSlash(false);
    setSlashQuery("");
    setSlashIndex(0);
  }
  function choose(type: string) {
    // Slash text stays in the document until an insertion is explicitly accepted.
    editor.tf.delete({
      distance: slashQuery.length + 1,
      unit: "character",
      reverse: true,
    });
    const index = editor.selection?.anchor.path[0];
    insert(editor, type);
    if (type === "blockquote" && index !== undefined)
      // Wrapping the paragraph in a quote replaces its DOM nodes, which drops the browser's caret.
      window.requestAnimationFrame(() => {
        const end = editor.api.end([index]);
        if (end) editor.tf.select(end);
        editor.tf.focus();
      });
    closeSlash();
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || readOnly)
      return;
    if (
      event.altKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      event.stopPropagation();
      moveBlock(editor, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === "x"
    ) {
      event.preventDefault();
      editor.tf.toggleMark("strikethrough");
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && closeCodeFence(editor)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Tab" && editor.api.some({ match: { type: "li" } })) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) unindentListItems(editor);
      else indentListItems(editor);
      return;
    }
    if (
      event.key === "/" &&
      !slash &&
      !event.metaKey &&
      !event.ctrlKey &&
      !editor.api.some({ match: { type: "code_block" } })
    ) {
      const before = textBeforeCaret(editor);
      if (before !== null && slashMayOpen(before)) {
        // The menu opens at the caret, where "/" was typed (detA MK-05).
        setSlashAnchor(caretRect());
        setSlash(true);
        setSlashIndex(0);
        setSlashQuery("");
      }
      return;
    }
    if (!slash) {
      if (event.key === "Escape" && onEscape) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSlash();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setSlashIndex(
        (current) =>
          (current +
            (event.key === "ArrowDown" ? 1 : -1) +
            Math.max(choices.length, 1)) %
          Math.max(choices.length, 1),
      );
    } else if (
      (event.key === "Enter" || event.key === "Tab") &&
      choices[slashIndex]
    ) {
      event.preventDefault();
      event.stopPropagation();
      choose(choices[slashIndex][0]);
    } else if (event.key === "Backspace") {
      if (!slashQuery) closeSlash();
      else {
        setSlashQuery((current) => current.slice(0, -1));
        setSlashIndex(0);
      }
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      // A query that matches nothing keeps the menu open on "No matching
      // blocks"; a space means the "/" was text after all.
      if (/\s/.test(event.key)) closeSlash();
      else {
        setSlashQuery(slashQuery + event.key);
        setSlashIndex(0);
      }
    } else if (
      ["ArrowLeft", "ArrowRight", "Home", "End", "Enter", "Tab"].includes(
        event.key,
      )
    )
      closeSlash();
  }
  // Exporting starts from the "…" menu; its result dialog lives here.
  // What Export takes: the selection when the "…" menu opened, before the
  // menu took focus, else the whole text.
  const exportSnapshot = useRef<MarkdownExportSource | null>(null);
  const exportSource = (): MarkdownExportSource => {
    report();
    const whole = emitted.current;
    const selection = sourceEditor.current?.view?.state.selection.main;
    if (source && selection && !selection.empty)
      return {
        kind: "selection",
        body: whole.slice(selection.from, selection.to),
        context: whole,
      };
    const nativeSelection = window.getSelection();
    const rich =
      !source &&
      nativeSelection &&
      container.current?.contains(nativeSelection.anchorNode)
        ? editor.api.toSlateRange(nativeSelection, {
            exactMatch: false,
            suppressThrow: true,
          })
        : editor.selection;
    const selected =
      !source && rich && !RangeApi.isCollapsed(rich)
        ? writeMarkdown(editor.api.fragment(rich))
        : whole;
    return { kind: "markdown", body: selected };
  };
  const captureExport = (open: boolean) => {
    exportSnapshot.current = open ? exportSource() : exportSnapshot.current;
  };
  const markdownExport = useMarkdownExport(
    () => exportSnapshot.current ?? exportSource(),
  );
  const moreItems = (
    <DropdownMenuGroup>
      <DropdownMenuItem
        onSelect={() => {
          report();
          void writeClipboard(emitted.current).then((failure) =>
            statusLine.show(
              failure === null
                ? { message: "Copied Markdown" }
                : { tone: "error", message: "Couldn't copy the Markdown" },
            ),
          );
        }}
      >
        Copy Markdown
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={markdownExport.busy}
        onSelect={() => void markdownExport.run()}
      >
        Export Markdown with files…
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
  // Why the rich editor can't hold this text: one caption, never a notice
  // that pushes the text down (detA DS-03, plans DR-01).
  const reason = forced && (
    <span className="editor-caption" role="note">
      Source editing · has {document.reasons.join(", ")}
    </span>
  );
  const toggleSource = () => {
    // Each side starts from the other's latest text.
    report();
    setSourceMode((current) => !current);
    closeSlash();
  };
  const sourceToggle =
    !forced &&
    (chrome === "floating" ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={source ? "Use rich editor" : "Edit Markdown source"}
        aria-pressed={source}
        onMouseDown={keepFocus}
        onClick={toggleSource}
      >
        <FileCode2 aria-hidden="true" />
        Markdown
      </Button>
    ) : (
      <IconButton
        type="button"
        label={source ? "Use rich editor" : "Edit Markdown source"}
        aria-pressed={source}
        onMouseDown={keepFocus}
        onClick={toggleSource}
      >
        <FileCode2 />
      </IconButton>
    ));
  const attach = !readOnly && (
    <IconButton
      type="button"
      label="Insert attachment"
      onMouseDown={keepFocus}
      onClick={beginAttachment}
    >
      <Paperclip />
    </IconButton>
  );
  /** The editor's controls, in the host's reserved row or under the text. */
  function controls(formatting: ReactNode | null) {
    if (controlsHidden) return null;
    const row = (
      <span
        className="editor-controls"
        data-chrome={chrome}
        data-hosted={chromeHost ? "" : undefined}
      >
        {reason}
        {chrome !== "compact"
          ? (formatting ?? (
              <>
                {attach}
                <DropdownMenu onOpenChange={captureExport}>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      type="button"
                      label="More formatting"
                      onMouseDown={keepFocus}
                    >
                      <MoreHorizontal />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {moreItems}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ))
          : attach}
        {sourceToggle}
      </span>
    );
    return chromeHost ? createPortal(row, chromeHost) : row;
  }

  return (
    <section
      ref={container}
      className="markdown-editor"
      data-chrome={chrome}
      aria-label={label}
      onPasteCapture={(event) => {
        if (readOnly) return;
        const screenshots = Array.from(event.clipboardData.items ?? [])
          .filter(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          )
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        if (!screenshots.length) return;
        event.preventDefault();
        event.stopPropagation();
        captureFiles(screenshots);
      }}
      onDragOverCapture={(event) => {
        if (!readOnly && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onDropCapture={(event) => {
        if (readOnly || !event.dataTransfer.files?.length) return;
        event.preventDefault();
        event.stopPropagation();
        captureFiles(Array.from(event.dataTransfer.files), {
          x: event.clientX,
          y: event.clientY,
        });
      }}
      onFocus={(event) =>
        setFocused(
          event.target instanceof HTMLElement &&
            event.target.classList.contains("rich-document"),
        )
      }
      onBlur={() => {
        setFocused(false);
        closeSlash();
        report();
      }}
      onKeyDownCapture={(event) => {
        // Escape finishes editing, and a Ctrl/Cmd shortcut may save or submit
        // in this same keypress: the host must hold the text first.
        if (event.key === "Escape") report();
        else if (
          (event.metaKey || event.ctrlKey) &&
          pendingSince.current !== null
        )
          flushSync(report);
        if (event.defaultPrevented) return;
        if (
          event.target instanceof HTMLElement &&
          event.target.closest(
            '[role="dialog"], [role="menu"], [role="listbox"]',
          )
        )
          return;
        if (
          !readOnly &&
          !source &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "k"
        ) {
          const link = (
            chromeHost ?? container.current
          )?.querySelector<HTMLButtonElement>('[aria-label="Link"]');
          if (link) {
            event.preventDefault();
            event.stopPropagation();
            link.click();
          }
        }
        if (
          event.key === "Escape" &&
          onEscape &&
          !slash &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
      }}
      onKeyDown={(event) => {
        // Escape in the source editor finishes too, as in the rich text.
        if (
          event.key === "Escape" &&
          onEscape &&
          !slash &&
          !event.defaultPrevented
        ) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
      }}
    >
      {recovery.active &&
        valueLinks.size > 0 &&
        linksProtected &&
        !recoveryError && (
          <p
            role="status"
            aria-label="Attachment draft protection"
            className="sr-only"
          >
            Draft protected. Workspace attachments stay protected through Undo.
          </p>
        )}
      {source ? (
        <>
          {controls(null)}
          <CodeMirror
            ref={sourceEditor}
            value={value}
            autoFocus={autoFocus}
            readOnly={readOnly}
            editable={!readOnly}
            aria-label={`${label} source`}
            theme="none"
            extensions={sourceEditorExtensions}
            onChange={(next) => {
              if (readOnly || next === value) return;
              // The host takes the text as typed. The rich value reads it
              // once typing pauses, or on switching back to rich text.
              emitted.current = next;
              sourceUnread.current = true;
              setAssessed((current) => ({ ...current, source: next }));
              reportWhenIdle();
              onChange(next);
            }}
          />
        </>
      ) : (
        <Plate
          editor={editor}
          readOnly={readOnly}
          onSelectionChange={({ selection }) => {
            if (selection) lastSelection.current = selection;
          }}
          onValueChange={({ value: next }: { value: Value }) => {
            if (readOnly) return;
            // Selection, focus, initialization and the host's own value are
            // not edits.
            const edits = editor.operations.filter(
              (operation) =>
                operation.type !== "set_selection" &&
                !outsideOperations.current.has(operation),
            );
            if (!edits.length) return;
            setEmpty(blank(next));
            if (pendingSince.current === null) {
              pendingSince.current = Date.now();
              onPendingChange?.(true);
            }
            // A new attachment link is reported at once, so Undo protects it
            // before the person can remove it again.
            const linksFile = edits.some(
              (operation) =>
                (operation.type === "insert_node" ||
                  operation.type === "insert_text" ||
                  operation.type === "set_node") &&
                JSON.stringify(operation).includes("ticketd://attachment/"),
            );
            if (linksFile) report();
            else reportWhenIdle();
          }}
        >
          {chrome !== "compact" &&
            !readOnly &&
            controls(
              <SessionFormatting
                floating={chrome === "floating"}
                onAttach={beginAttachment}
                more={moreItems}
                onMenuOpenChange={captureExport}
              />,
            )}
          <AttachmentProtection.Provider value={protectAttachment}>
            <PlateContent
              readOnly={readOnly}
              // Drawn by CSS from this property, never as Slate's placeholder node: that node is text
              // inside the editable, so native input (autocorrect, dictation) could keep it beside
              // typed text or fold it into what is saved. Only while the document is empty.
              {...(placeholder && empty
                ? {
                    "data-empty": "",
                    style: {
                      "--editor-placeholder": JSON.stringify(placeholder),
                    } as CSSProperties,
                  }
                : {})}
              aria-label={`${label} rich text`}
              role={slash ? "combobox" : "textbox"}
              aria-autocomplete={slash ? "list" : undefined}
              aria-haspopup={slash ? "listbox" : undefined}
              aria-expanded={slash ? true : undefined}
              aria-controls={slash ? slashMenuId : undefined}
              aria-activedescendant={
                slash && choices[slashIndex]
                  ? `${slashMenuId}-${choices[slashIndex][0]}`
                  : undefined
              }
              onCompositionStart={closeSlash}
              onMouseDown={closeSlash}
              className="rich-document"
              onKeyDown={keyDown}
              onPaste={(event) => {
                if (readOnly) return;
                const pasted = event.clipboardData.getData("text/plain");
                if (!pasted) return;
                event.preventDefault();
                event.stopPropagation();
                const incoming = readMarkdown(pasted);
                if (incoming.reasons.length || !pasted.trim())
                  editor.tf.insertText(pasted);
                else {
                  const first = incoming.value[0];
                  const last = incoming.value[incoming.value.length - 1];
                  // Parsing drops a paragraph's edge whitespace, but a paste must keep it:
                  // "hello" + " world" is "hello world". It goes in as a plain text node so it
                  // never inherits a mark from the pasted text next to it.
                  const lead =
                    first?.type === "p"
                      ? (/^[ \t]*/.exec(pasted)?.[0] ?? "")
                      : "";
                  const trail =
                    last?.type === "p"
                      ? (/[ \t]*$/.exec(pasted)?.[0] ?? "")
                      : "";
                  if (lead)
                    editor.tf.insertNodes({ text: lead }, { select: true });
                  // Slate merges a fragment's first block into the current block.
                  // An empty leading paragraph protects a pasted heading/list/table.
                  editor.tf.insertFragment(
                    first?.type === "p"
                      ? incoming.value
                      : [
                          { type: "p", children: [{ text: "" }] },
                          ...incoming.value,
                        ],
                  );
                  if (trail)
                    editor.tf.insertNodes({ text: trail }, { select: true });
                }
              }}
              onDragOver={(event) => {
                if (
                  event.dataTransfer.types.includes(
                    "application/x-ticketd-block",
                  )
                )
                  event.preventDefault();
                event.stopPropagation();
              }}
              onDrop={(event) => {
                const data = event.dataTransfer.getData(
                  "application/x-ticketd-block",
                );
                if (!data || readOnly) return;
                event.preventDefault();
                event.stopPropagation();
                let payload: unknown;
                try {
                  payload = JSON.parse(data);
                } catch {
                  return;
                }
                if (
                  typeof payload !== "object" ||
                  payload === null ||
                  !("editorId" in payload) ||
                  payload.editorId !== editorId ||
                  !("index" in payload) ||
                  typeof payload.index !== "number" ||
                  !Number.isInteger(payload.index) ||
                  payload.index < 0 ||
                  payload.index >= editor.children.length
                )
                  return;
                const range = editor.api.findEventRange(event);
                const destination = range?.anchor.path[0];
                if (
                  destination !== undefined &&
                  destination >= 0 &&
                  destination < editor.children.length
                )
                  editor.tf.moveNodes({
                    at: [payload.index],
                    to: [destination],
                  });
              }}
            />
          </AttachmentProtection.Provider>
          {!readOnly && chrome === "compact" && (
            <SelectionBubble focused={focused} />
          )}
          {(chrome === "compact" || readOnly) && controls(null)}
          {slash && !readOnly && (
            <SlashMenu
              id={slashMenuId}
              anchor={slashAnchor}
              query={slashQuery}
              choices={choices}
              index={slashIndex}
              onChoose={choose}
              onClose={closeSlash}
            />
          )}
        </Plate>
      )}
      {!readOnly && (
        <AttachmentPicker
          ticketReference={attachmentTicketReference}
          open={attachmentPicker}
          capture={capture}
          onOpenChange={(open) => {
            setAttachmentPicker(open);
            if (!open) insertion.current = null;
          }}
          onPick={insertAttachment}
        />
      )}
      {markdownExport.element}
      {dropFailure && (
        <Alert tone="error" size="compact" role="alert">
          <AlertDescription>{dropFailure}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

/** The node labels of a flowchart ("Cart, Pay, Receipt"), so a collapsed diagram says what it holds. */
function diagramLabels(source: string) {
  const labels: string[] = [];
  for (const match of source.matchAll(
    /\b[\w-]+\s*(?:\[\[?|\(\(?|\{)\s*"?([^\])}"]+?)"?\s*(?:\]\]?|\)\)?|\})/g,
  ))
    if (match[1] && !labels.includes(match[1].trim()))
      labels.push(match[1].trim());
  // Bare node names (Cart-->Pay-->Receipt) read as their own labels.
  if (labels.length === 0)
    for (const part of source.split(/\s*(?:-->|---|==>|-\.->|;|\n)\s*/)) {
      const name = part.replace(/^\|[^|]*\|\s*/, "").trim();
      if (
        /^[A-Za-z][\w-]*$/.test(name) &&
        !/^(graph|flowchart|TD|TB|LR|RL|BT)$/i.test(name) &&
        !labels.includes(name)
      )
        labels.push(name);
    }
  return labels.slice(0, 4).join(", ");
}

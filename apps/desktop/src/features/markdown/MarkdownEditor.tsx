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
} from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Prec } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView, keymap } from "@codemirror/view";
import { TextApi, NodeApi, type Value } from "platejs";
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
import { upsertLink } from "@platejs/link";
import { LinkPlugin } from "@platejs/link/react";
import { toggleCodeBlock } from "@platejs/code-block";
import { CodeBlockPlugin } from "@platejs/code-block/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bold as BoldIcon,
  Code,
  Italic as ItalicIcon,
  Link,
  List,
  ListChecks,
  MoreHorizontal,
  FileCode2,
  Paperclip,
  Eye,
} from "lucide-react";
import { CopySourceButton } from "./CopySourceButton";
import { MermaidDiagram } from "./MermaidDiagram";
import {
  checklistRule,
  closeCodeFence,
  markdownLinkRule,
  openFenceRule,
} from "./input-rules";
import { linkPluginOptions } from "./link-options";
import { insertions, slashChoices, slashMayOpen } from "./slash-menu";
import { applyExternalValue } from "./external-value";
import { readMarkdown, writeMarkdown } from "./plate-markdown";
import "./markdown-editor.css";
const AttachmentProtection = createContext<(uri: string) => Promise<void>>(
  async () => {},
);

// Source mode keeps what is typed: Enter inserts a plain newline, so list markers are not
// doubled and a closing fence never inherits indentation.
const sourceExtensions = [
  markdown({ addKeymap: false }),
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
    code_block: "pre",
    code_line: "div",
    tr: "tr",
    td: "td",
    th: "th",
    hr: "div",
    a: "a",
    br: "span",
  } as const;
  const tag = tags[element.type as keyof typeof tags] ?? "div";
  if (element.type === "table")
    return (
      <PlateElement {...props} as="table">
        <tbody>{children}</tbody>
      </PlateElement>
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
              title: String(element.title ?? ""),
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
            <button
              type="button"
              className="attachment-inline-preview"
              aria-label={`Preview attachment: ${NodeApi.string(element)}`}
              title="Preview attachment"
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

function CodeFence(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useEditorReadOnly();
  const languageId = useId();
  // The language field is an editing tool: it shows only while the caret is in this block.
  const editing = useEditorSelector(
    (current) => {
      const at = current.selection?.anchor.path[0];
      const path = current.api.findPath(props.element);
      return at !== undefined && path !== undefined && path[0] === at;
    },
    [props.element],
  );
  return (
    <PlateElement {...props} as="div">
      <FieldGroup
        contentEditable={false}
        className="code-language"
        data-editing={editing}
      >
        <Field orientation="horizontal">
          <FieldLabel htmlFor={languageId}>Code language</FieldLabel>
          <Input
            id={languageId}
            list={`${languageId}-languages`}
            value={String(props.element.lang ?? "")}
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
          <datalist id={`${languageId}-languages`}>
            {[
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
            ].map((lang) => (
              <option key={lang} value={lang} />
            ))}
          </datalist>
        </Field>
      </FieldGroup>
      <pre>{props.children}</pre>
    </PlateElement>
  );
}

function Diagram(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useEditorReadOnly();
  const source = String(props.element.source ?? "");
  return (
    <PlateElement {...props}>
      <div contentEditable={false} className="diagram-editor">
        <MermaidDiagram source={source} />
        <details>
          <summary>
            <Code aria-hidden="true" />
            <span className="diagram-summary-label">
              Mermaid diagram
              {diagramLabels(source) && ` · ${diagramLabels(source)}`}
            </span>
            <span className="diagram-summary-action">Edit source</span>
            <span className="sr-only">Diagram source</span>
          </summary>
          <CodeMirror
            value={source}
            readOnly={readOnly}
            editable={!readOnly}
            aria-label="Mermaid source"
            extensions={sourceExtensions}
            onChange={(next) => {
              const path = editor.api.findPath(props.element);
              if (!readOnly && path && next !== source)
                editor.tf.setNodes({ source: next }, { at: path });
            }}
          />
        </details>
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

function Toolbar({
  visible,
  floating,
  onAttach,
}: {
  visible: boolean;
  floating: boolean;
  onAttach: () => void;
}) {
  const editor = useEditorRef();
  const selected = useEditorSelector(
    (current) => !!current.selection && !current.api.isCollapsed(),
    [],
  );
  const [url, setUrl] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const keepFocus = (event: MouseEvent) => event.preventDefault();
  const essentials = [
    [
      "Bold",
      <BoldIcon key="b" />,
      () => {
        editor.tf.toggleMark("bold");
        editor.tf.focus();
      },
    ],
    [
      "Italic",
      <ItalicIcon key="i" />,
      () => {
        editor.tf.toggleMark("italic");
        editor.tf.focus();
      },
    ],
  ] as const;
  const listButtons = [
    ["Bullet list", <List key="l" />, "ul"],
    ["Checklist", <ListChecks key="c" />, "task"],
  ] as const;
  return (
    // Never `hidden`: a collapsed toolbar would move everything below it, so a first click
    // on Post/Done/Retry (which blurs the editor) would land on the wrong element. A toolbar that
    // appears only on focus floats above the frame instead of holding an empty band inside it.
    <div
      className="rich-toolbar"
      data-floating={floating || undefined}
      data-visible={visible}
      aria-hidden={!visible}
      inert={!visible}
      role="toolbar"
      aria-label={selected ? "Selection formatting" : "Document formatting"}
    >
      {essentials.map(([title, icon, run]) => (
        <Button
          key={title}
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={title}
          title={title}
          onMouseDown={keepFocus}
          onClick={run}
        >
          {icon}
        </Button>
      ))}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Insert attachment"
        title="Insert attachment"
        onMouseDown={keepFocus}
        onClick={onAttach}
      >
        <Paperclip />
      </Button>
      <Popover
        open={linkOpen}
        onOpenChange={(open) => {
          setLinkOpen(open);
          if (open) setUrl("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Link"
            title="Link"
            onMouseDown={keepFocus}
          >
            <Link />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} collisionPadding={12}>
          <p className="mb-2 text-xs text-muted-foreground">Link a Document</p>
          <DocumentPicker
            autoFocus
            onPick={(picked) => {
              const collapsed = !editor.selection || editor.api.isCollapsed();
              upsertLink(editor, {
                url: `ticketd://document/${picked.id}`,
                ...(collapsed ? { text: picked.heading } : {}),
              });
              setLinkOpen(false);
              editor.tf.focus();
            }}
          />
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const target = url.trim();
              if (/^(https?:|mailto:|ticketd:\/\/|\/|#)/i.test(target)) {
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
                  upsertLink(editor, {
                    url: target,
                    ...(text ? { text } : {}),
                  });
                  setUrl("");
                  setLinkOpen(false);
                  editor.tf.focus();
                })();
              }
            }}
          >
            <label htmlFor="rich-link-url">Link URL</label>
            <Input
              id="rich-link-url"
              placeholder="https://… or ticketd://…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button type="submit">Apply link</Button>
          </form>
        </PopoverContent>
      </Popover>
      {listButtons.map(([title, icon, type]) => (
        <Button
          key={type}
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={title}
          title={title}
          onMouseDown={keepFocus}
          onClick={() => insert(editor, type)}
        >
          {icon}
        </Button>
      ))}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Inline code"
        title="Inline code"
        onMouseDown={keepFocus}
        onClick={() => {
          editor.tf.toggleMark("code");
          editor.tf.focus();
        }}
      >
        <Code />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="More formatting"
            title="More formatting"
            onMouseDown={keepFocus}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onSelect={() => {
                editor.tf.toggleMark("strikethrough");
                editor.tf.focus();
              }}
            >
              Strikethrough
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => editor.undo()}>
              Undo
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => editor.redo()}>
              Redo
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => moveBlock(editor, -1)}>
              Move block up
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => moveBlock(editor, 1)}>
              Move block down
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Insert</DropdownMenuLabel>
            {insertions.map(([type, title]) => (
              <DropdownMenuItem
                key={type}
                onSelect={() => insert(editor, type)}
              >
                {title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Table</DropdownMenuLabel>
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
    inputRules: [openFenceRule],
  }),
  createPlatePlugin({
    key: "mermaid",
    node: { isElement: true, isVoid: true, component: Diagram },
  }),
  createPlatePlugin({
    key: "br",
    node: { isElement: true, isInline: true, isVoid: true },
  }),
];

export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
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
  /** Keep the formatting toolbar shown while the editor is idle, so a dialog never holds an empty band. */
  persistentToolbar?: boolean;
  /** Recovery owner to explain independent Undo protection in attachment usage. */
  recoveryOwner?: string;
  /** Current ticket context ranks related files; it never changes reference ownership. */
  attachmentTicketReference?: string | null | undefined;
}

let pointerDown = false;
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", () => (pointerDown = true), true);
  for (const type of ["pointerup", "pointercancel"])
    document.addEventListener(type, () => (pointerDown = false), true);
}

/** Controlled draft editor. Persistence and external-update decisions belong to its caller. */
export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  label = "Markdown document",
  autoFocus = false,
  placeholder,
  focusRequest = 0,
  focusLink,
  paragraphAfterQuote = false,
  persistentToolbar = false,
  recoveryOwner = label,
  attachmentTicketReference = null,
}: MarkdownEditorProps) {
  const recovery = useDraftRecovery();
  const recoveryError = useDraftRecoveryError();
  const [historyOwner] = useState(
    () => `undo:${recoveryOwner}:${crypto.randomUUID()}`,
  );
  const [protectedValue, setProtectedValue] = useState<string | null>(null);
  const protectAttachment = useCallback(
    (uri: string) =>
      recovery.put(historyOwner, null, [`[File](${uri})`], "undo"),
    [recovery, historyOwner],
  );
  useEffect(() => {
    let current = true;
    void recovery
      .put(historyOwner, null, value ? [value] : [], "undo")
      .then(() => {
        if (current) setProtectedValue(value);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [recovery, historyOwner, value, recoveryError]);
  useEffect(
    () => () => {
      void recovery.put(historyOwner, null, []).catch(() => {});
    },
    [recovery, historyOwner],
  );
  // The formatting toolbar appears while focus is anywhere in the editor (including the toolbar,
  // so it stays keyboard reachable) and while one of its menus holds focus.
  const [active, setActive] = useState(false);
  const [assessed, setAssessed] = useState<{
    source: string;
    document: Pick<ReturnType<typeof readMarkdown>, "value" | "reasons">;
  }>(() => ({ source: value, document: readMarkdown(value) }));
  let document = assessed.document;
  if (assessed.source !== value) {
    document = readMarkdown(value);
    setAssessed({ source: value, document });
  }
  const [sourceMode, setSourceMode] = useState(false);
  const [slash, setSlash] = useState(false);
  const editorId = useId();
  const slashMenuId = `${editorId}-slash-menu`;
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState("");
  const source = sourceMode || document.reasons.length > 0;
  // In the rich editor the copy and source buttons share the toolbar row instead of adding one.
  const inlineMode = !source && !readOnly;
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
  const emitted = useRef(value);
  const synchronizing = useRef(false);
  const [initialMarkdown] = useState(() => writeMarkdown(document.value));
  const previousMarkdown = useRef(initialMarkdown);
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
      hr: Element,
      br: Element,
      bold: Leaf,
      italic: Leaf,
      code: Leaf,
      strikethrough: Leaf,
    },
    value: document.value,
  });
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
    insertion.current = {
      rich: rich ?? editor.selection ?? lastSelection.current,
      source: sourceEditor.current?.view?.state.selection.main,
      markdown: value,
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
      const from = before?.from ?? caret.from;
      const to = before?.from ?? caret.to;
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
      } else if (pending.rich) editor.tf.select(pending.rich);
      else editor.tf.select(editor.api.end([]) ?? [0]);
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
    synchronizing.current = true;
    emitted.current = value;
    const next = document.value;
    previousMarkdown.current = writeMarkdown(next);
    applyExternalValue(editor, next, lastSelection.current);
    synchronizing.current = false;
  }, [value, document, editor]);
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
    insert(editor, type);
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
        setSlash(true);
        setSlashIndex(0);
        setSlashQuery("");
      }
      return;
    }
    if (!slash) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setSlash(false);
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
      const next = slashQuery + event.key;
      if (/\s/.test(event.key) || slashChoices(next).length === 0) closeSlash();
      else {
        setSlashQuery(next);
        setSlashIndex(0);
      }
    } else if (
      ["ArrowLeft", "ArrowRight", "Home", "End", "Enter", "Tab"].includes(
        event.key,
      )
    )
      closeSlash();
  }
  return (
    <section
      ref={container}
      className="markdown-editor"
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
      onFocus={() => setActive(true)}
      onBlur={(event) => {
        closeSlash();
        const next = event.relatedTarget;
        if (
          next instanceof Element &&
          (event.currentTarget.contains(next) ||
            next.closest(
              "[data-slot=popover-content], [data-slot=dropdown-menu-content]",
            ))
        )
          return;
        // The toolbar docks in the frame, so hiding it moves everything below. A press elsewhere
        // (Post, Done) blurs on pointer down; collapse only after the pointer is released so the
        // click still lands on the control that was pressed.
        if (pointerDown) {
          globalThis.document.addEventListener(
            "pointerup",
            () => setTimeout(() => setActive(false), 0),
            { once: true },
          );
          return;
        }
        setActive(false);
      }}
    >
      {recoveryError && (
        <Alert variant="destructive">
          <AlertTitle>Could not protect recoverable drafts</AlertTitle>
          <AlertDescription>
            Keep this window open. {recoveryError}
            <Button type="button" onClick={recovery.retry}>
              Retry draft recovery
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {recovery.active &&
        protectedValue === value &&
        !recoveryError &&
        value.includes("ticketd://attachment/") && (
          <p
            role="status"
            aria-label="Attachment draft protection"
            className="text-xs text-muted-foreground"
          >
            Draft protected
            <span className="sr-only">
              . Workspace attachments stay protected through Undo.
            </span>
          </p>
        )}
      <div
        className={`editor-mode${inlineMode ? " editor-mode--inline" : ""}`}
        data-persistent={persistentToolbar || undefined}
      >
        <CopySourceButton
          compact
          source={value}
          label={`Copy ${label} Markdown`}
        />
        {source && !readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Insert attachment"
            title="Insert attachment"
            onMouseDown={(event) => event.preventDefault()}
            onClick={beginAttachment}
          >
            <Paperclip />
          </Button>
        )}
        <Button
          disabled={document.reasons.length > 0}
          type="button"
          variant="ghost"
          size={inlineMode ? "icon-sm" : "sm"}
          aria-pressed={source}
          {...(inlineMode
            ? {
                "aria-label": "Edit Markdown source",
                title: "Edit Markdown source",
              }
            : {})}
          onClick={() => {
            setSourceMode((current) => !current);
            closeSlash();
          }}
        >
          {document.reasons.length > 0 ? (
            "Markdown source required"
          ) : source ? (
            "Use rich editor"
          ) : inlineMode ? (
            <FileCode2 />
          ) : (
            "Edit Markdown source"
          )}
        </Button>
      </div>
      {document.reasons.length > 0 && (
        <Alert>
          <AlertTitle>Markdown source preserves this document</AlertTitle>
          <AlertDescription>{document.reasons.join(" ")}</AlertDescription>
        </Alert>
      )}
      {source ? (
        <CodeMirror
          ref={sourceEditor}
          value={value}
          autoFocus={autoFocus}
          readOnly={readOnly}
          editable={!readOnly}
          aria-label={`${label} source`}
          extensions={sourceEditorExtensions}
          onChange={(next) => {
            if (!readOnly && next !== value) {
              emitted.current = next;
              synchronizing.current = true;
              const parsed = readMarkdown(next);
              setAssessed({ source: next, document: parsed });
              previousMarkdown.current = writeMarkdown(parsed.value);
              editor.tf.setValue(parsed.value);
              synchronizing.current = false;
              onChange(next);
            }
          }}
        />
      ) : (
        <Plate
          editor={editor}
          readOnly={readOnly}
          onSelectionChange={({ selection }) => {
            if (selection) lastSelection.current = selection;
          }}
          onValueChange={({ value: next }: { value: Value }) => {
            if (readOnly || synchronizing.current) return;
            // Selection, focus and initialization never emit a write.
            if (
              !editor.operations.some(
                (operation) => operation.type !== "set_selection",
              )
            )
              return;
            const markdown = writeMarkdown(next);
            if (markdown !== previousMarkdown.current) {
              previousMarkdown.current = markdown;
              // This controlled echo already consists of supported Plate nodes.
              // Re-parsing it would repeat the entire fidelity check per keypress.
              setAssessed({
                source: markdown,
                document: { value: next, reasons: [] },
              });
              emitted.current = markdown;
              onChange(markdown);
            }
          }}
        >
          {!readOnly && (
            <Toolbar
              visible={active || persistentToolbar}
              floating={!persistentToolbar}
              onAttach={beginAttachment}
            />
          )}
          <AttachmentProtection.Provider value={protectAttachment}>
            <PlateContent
              readOnly={readOnly}
              // Drawn by CSS from this property, never as Slate's placeholder node: that node is text
              // inside the editable, so native input (autocorrect, dictation) could keep it beside
              // typed text or fold it into what is saved. Only while the document is empty.
              {...(placeholder && value.trim() === ""
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
                if (incoming.reasons.length) editor.tf.insertText(pasted);
                else {
                  const first = incoming.value[0];
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
          {slash && !readOnly && (
            <div
              id={slashMenuId}
              className="slash-menu"
              role="listbox"
              aria-label="Insert block"
            >
              {choices.length ? (
                choices.map(([type, title], index) => (
                  <Button
                    key={type}
                    id={`${slashMenuId}-${type}`}
                    type="button"
                    role="option"
                    aria-selected={index === slashIndex}
                    variant={index === slashIndex ? "secondary" : "ghost"}
                    size="sm"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(type)}
                  >
                    {title}
                  </Button>
                ))
              ) : (
                <p>No matching blocks</p>
              )}
            </div>
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
      {dropFailure && <p role="alert">{dropFailure}</p>}
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

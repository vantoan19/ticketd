import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { TextApi, type Value } from "platejs";
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
  TaskListRules,
} from "@platejs/list-classic";
import { TablePlugin } from "@platejs/table/react";
import {
  insertTable,
  insertTableRow,
  insertTableColumn,
  deleteRow,
  deleteColumn,
} from "@platejs/table";
import { upsertLink } from "@platejs/link";
import { LinkPlugin } from "@platejs/link/react";
import { toggleCodeBlock, CodeBlockRules } from "@platejs/code-block";
import { CodeBlockPlugin } from "@platejs/code-block/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Plus,
  Undo2,
  Redo2,
  Link,
} from "lucide-react";
import { CopySourceButton } from "./CopySourceButton";
import { MermaidDiagram } from "./MermaidDiagram";
import { readMarkdown, writeMarkdown } from "./plate-markdown";
import "./markdown-editor.css";

const sourceExtensions = [markdown(), EditorView.lineWrapping];

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
  const path = editor.api.findPath(element);
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
      {...(element.type === "a"
        ? {
            href: /^(https?:|mailto:|\/|#)/i.test(String(element.url))
              ? String(element.url)
              : undefined,
            title: String(element.title ?? ""),
            onClick: (event: MouseEvent) => event.preventDefault(),
          }
        : {})}
      {...(element.type === "ol" ? { start: Number(element.start ?? 1) } : {})}
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
          <summary>Diagram source</summary>
          <CodeMirror
            value={source}
            readOnly={readOnly}
            editable={!readOnly}
            aria-label="Mermaid source"
            extensions={sourceExtensions}
            onChange={(next) => {
              const path = editor.api.findPath(props.element);
              if (path && next !== source)
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

const insertions = [
  ["p", "Paragraph"],
  ["h1", "Heading 1"],
  ["h2", "Heading 2"],
  ["h3", "Heading 3"],
  ["ul", "Bullet list"],
  ["ol", "Numbered list"],
  ["task", "Checklist"],
  ["blockquote", "Quote"],
  ["code_block", "Code fence"],
  ["table", "Table"],
  ["mermaid", "Mermaid diagram"],
] as const;

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

function Toolbar() {
  const editor = useEditorRef();
  const selected = useEditorSelector(
    (current) => !!current.selection && !current.api.isCollapsed(),
    [],
  );
  const [url, setUrl] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  return (
    <div
      className="rich-toolbar"
      role="toolbar"
      aria-label={selected ? "Selection formatting" : "Document formatting"}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm">
            <Plus data-icon="inline-start" />
            Insert
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuGroup>
            {insertions.map(([type, title]) => (
              <DropdownMenuItem
                key={type}
                onSelect={() => insert(editor, type)}
              >
                {title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {(
        [
          ["bold", "Bold"],
          ["italic", "Italic"],
          ["strikethrough", "Strikethrough"],
          ["code", "Inline code"],
        ] as const
      ).map(([key, title]) => (
        <Button
          key={key}
          type="button"
          size="sm"
          variant="ghost"
          aria-label={title}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            editor.tf.toggleMark(key);
            editor.tf.focus();
          }}
        >
          {title}
        </Button>
      ))}
      <Popover open={linkOpen} onOpenChange={setLinkOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" aria-label="Link">
            <Link />
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (/^(https?:|mailto:|\/|#)/i.test(url)) {
                upsertLink(editor, { url });
                setLinkOpen(false);
                editor.tf.focus();
              }
            }}
          >
            <label htmlFor="rich-link-url">Link URL</label>
            <Input
              id="rich-link-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button type="submit">Apply link</Button>
          </form>
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Undo"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => editor.undo()}
      >
        <Undo2 />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Redo"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => editor.redo()}
      >
        <Redo2 />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Move block up"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => moveBlock(editor, -1)}
      >
        <ArrowUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Move block down"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => moveBlock(editor, 1)}
      >
        <ArrowDown />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Drag selected block"
        draggable
        onDragStart={(event) => {
          const index = editor.selection?.anchor.path[0];
          if (index !== undefined)
            event.dataTransfer.setData(
              "application/x-ticketd-block",
              String(index),
            );
        }}
      >
        <GripVertical />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm">
            Table
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  label?: string;
  autoFocus?: boolean;
}

/** Controlled draft editor. Persistence and external-update decisions belong to its caller. */
export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  label = "Markdown document",
  autoFocus = false,
}: MarkdownEditorProps) {
  const document = useMemo(() => readMarkdown(value), [value]);
  const [sourceMode, setSourceMode] = useState(false);
  const [slash, setSlash] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState("");
  const source = sourceMode || document.reasons.length > 0;
  const container = useRef<HTMLElement>(null);
  const emitted = useRef(value);
  const synchronizing = useRef(false);
  const previousMarkdown = useRef(writeMarkdown(document.value));
  const editor = usePlateEditor({
    plugins: [
      ...[H1Plugin, H2Plugin, H3Plugin, H4Plugin, H5Plugin, H6Plugin].map(
        (plugin) => plugin.configure({ inputRules: [HeadingRules.markdown()] }),
      ),
      BlockquotePlugin.configure({ inputRules: [BlockquoteRules.markdown()] }),
      HorizontalRulePlugin,
      BoldPlugin.configure({
        inputRules: [
          BoldRules.markdown(),
          BoldRules.markdown({ variant: "_" }),
        ],
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
          TaskListRules.markdown(),
          TaskListRules.markdown({ checked: true }),
        ],
      }),
      TablePlugin.configure({ options: { disableMerge: true } }),
      LinkPlugin,
      CodeBlockPlugin.configure({
        inputRules: [CodeBlockRules.markdown({ on: "break" })],
      }),
      createPlatePlugin({
        key: "mermaid",
        node: { isElement: true, isVoid: true, component: Diagram },
      }),
      createPlatePlugin({
        key: "br",
        node: { isElement: true, isInline: true, isVoid: true },
      }),
    ],
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
      code_block: Element,
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
      else editor.tf.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, readOnly, source, editor]);
  useEffect(() => {
    if (value === emitted.current) return;
    synchronizing.current = true;
    emitted.current = value;
    const next = readMarkdown(value).value;
    previousMarkdown.current = writeMarkdown(next);
    editor.tf.setValue(next);
    synchronizing.current = false;
  }, [value, editor]);
  const choices = insertions.filter(([, title]) =>
    title.toLowerCase().includes(slashQuery.toLowerCase()),
  );
  function choose(type: string) {
    // Slash text stays in the document until an insertion is explicitly accepted.
    editor.tf.delete({
      distance: slashQuery.length + 1,
      unit: "character",
      reverse: true,
    });
    insert(editor, type);
    setSlash(false);
    setSlashQuery("");
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || readOnly) return;
    if (
      event.altKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      event.stopPropagation();
      moveBlock(editor, event.key === "ArrowUp" ? -1 : 1);
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
      !editor.api.some({ match: { type: "code_block" } })
    ) {
      setSlash(true);
      setSlashIndex(0);
      setSlashQuery("");
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
      if (!slashQuery) setSlash(false);
      else {
        setSlashQuery((current) => current.slice(0, -1));
        setSlashIndex(0);
      }
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      setSlashQuery((current) => current + event.key);
      setSlashIndex(0);
    }
  }
  return (
    <section ref={container} className="markdown-editor" aria-label={label}>
      <div className="editor-mode">
        <CopySourceButton source={value} label={`Copy ${label} Markdown`} />
        <Button
          disabled={document.reasons.length > 0}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={source}
          onClick={() => {
            setSourceMode((current) => !current);
            setSlash(false);
          }}
        >
          {document.reasons.length > 0
            ? "Markdown source required"
            : source
              ? "Use rich editor"
              : "Edit Markdown source"}
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
          value={value}
          autoFocus={autoFocus}
          readOnly={readOnly}
          editable={!readOnly}
          aria-label={`${label} source`}
          extensions={sourceExtensions}
          onChange={(next) => {
            if (next !== value) {
              emitted.current = next;
              synchronizing.current = true;
              const parsed = readMarkdown(next).value;
              previousMarkdown.current = writeMarkdown(parsed);
              editor.tf.setValue(parsed);
              synchronizing.current = false;
              onChange(next);
            }
          }}
        />
      ) : (
        <Plate
          editor={editor}
          readOnly={readOnly}
          onValueChange={({ value: next }: { value: Value }) => {
            if (synchronizing.current) return;
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
              emitted.current = markdown;
              onChange(markdown);
            }
          }}
        >
          {!readOnly && <Toolbar />}
          <PlateContent
            aria-label={`${label} rich text`}
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
                event.dataTransfer.types.includes("application/x-ticketd-block")
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
              const range = editor.api.findEventRange(event);
              const destination = range?.anchor.path[0];
              const origin = Number(data);
              if (
                destination !== undefined &&
                Number.isInteger(origin) &&
                origin >= 0 &&
                origin < editor.children.length
              )
                editor.tf.moveNodes({ at: [origin], to: [destination] });
            }}
          />
          {slash && !readOnly && (
            <div
              className="slash-menu"
              role="listbox"
              aria-label="Insert block"
            >
              {choices.length ? (
                choices.map(([type, title], index) => (
                  <Button
                    key={type}
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
    </section>
  );
}

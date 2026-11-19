import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import { defaultHandlers, type Handle } from "mdast-util-to-markdown";
import { TextApi, type Descendant, type TElement, type Value } from "platejs";
import type { Root, RootContent, PhrasingContent } from "mdast";

declare module "mdast" {
  interface LinkData {
    /** The link was a bare URL in the source: write it back without `<>` or `[]()`. */
    autolink?: "bare";
  }
  interface BreakData {
    /** The break was written as trailing spaces, not a backslash. */
    spaces?: boolean;
  }
}

/** The current fence source, joining Plate code lines without losing line breaks. */
export function codeBlockText(node: TElement): string {
  return node.children
    .map((child) =>
      TextApi.isText(child)
        ? child.text
        : child.children
            .map((leaf) => (TextApi.isText(leaf) ? leaf.text : ""))
            .join(""),
    )
    .join("\n");
}

const stringifyOptions = {
  bullet: "-",
  fences: true,
  listItemIndent: "one",
  // `---`, the divider people and agents write; the default is `***`.
  rule: "-",
} as const;

const urlHole = "TICKETDLINKURL";
/** A link destination with only the escapes Markdown needs; remark also escapes `&`, `(` and `)`. */
function destination(url: string, titled: boolean): string {
  // An entity-looking `&amp;` would read back as `&`; every other `&` is plain text.
  const entities = (text: string) =>
    text.replace(/&(?=[#A-Za-z0-9]+;)/g, "\\&");
  if (!url) return titled ? "<>" : "";
  if (/[\0- \u007F\\<>]/.test(url) || !balanced(url))
    return `<${entities(url.replace(/[<>\\]/g, "\\$&"))}>`;
  return entities(url);
}
function balanced(url: string): boolean {
  let depth = 0;
  for (const character of url) {
    if (character === "(") depth += 1;
    else if (character === ")" && --depth < 0) return false;
  }
  return depth === 0;
}
/** Whether `<url>` says what this link says: its text is its address. */
function isAutolink(label: string, url: string): boolean {
  return (
    !!label &&
    (label === url || url === `mailto:${label}`) &&
    /^[a-z][a-z+.-]+:/i.test(url) &&
    !/[\0- <>\u007F]/.test(url)
  );
}

const handlers: { link: Handle; break: Handle } = {
  link(node, parent, state, info) {
    const only = node.children.length === 1 ? node.children[0] : undefined;
    const label = only?.type === "text" ? only.value : "";
    if (!node.title && node.data?.autolink === "bare") return label;
    // The `<address>` form remark writes, without its `&` escape.
    if (!node.title && isAutolink(label, node.url)) return `<${label}>`;
    // remark escapes `&`, `(` and `)` in a destination; write the destination ourselves.
    const written = defaultHandlers.link(
      { ...node, url: urlHole },
      parent,
      state,
      info,
    );
    return written.replace(urlHole, () =>
      destination(node.url, Boolean(node.title)),
    );
  },
  break(node, parent, state, info) {
    const written = defaultHandlers.break(node, parent, state, info);
    return written === "\\\n" && node.data?.spaces ? "  \n" : written;
  },
};
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, { ...stringifyOptions, handlers });

/**
 * remark escapes punctuation (`*`, `[`, `_`, `.`) that is only sometimes syntax. Each escape is
 * dropped when the text still parses back as the same plain text, so stored text stays as typed.
 * `relaxed` records that an escape was dropped.
 */
let relaxed = false;
const lenient = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, {
    ...stringifyOptions,
    handlers: {
      ...handlers,
      text(node, _parent, state, info) {
        let text = state.safe(node.value, info);
        // Table cells, HTML, entities and code need their escapes wherever they appear.
        if (/[\n|<>&`]/.test(node.value) || node.value !== node.value.trim())
          return text;
        for (let index = 0; index < text.length - 1;) {
          if (
            text[index] === "\\" &&
            /[!-/:-@[-`{-~]/.test(text[index + 1] ?? "")
          ) {
            const candidate = text.slice(0, index) + text.slice(index + 1);
            // A typed URL reads back as an autolink, so `https\://` is noise, not protection.
            const urlColon =
              text[index + 1] === ":" &&
              text.startsWith("//", index + 2) &&
              /\b(?:https?|ftp)$/i.test(text.slice(0, index));
            if (urlColon || isPlainText(candidate, node.value)) {
              text = candidate;
              relaxed = true;
              continue;
            }
            index += 2;
          } else index += 1;
        }
        return text;
      },
    },
  });

function isPlainText(source: string, value: string): boolean {
  const [paragraph, ...rest] = processor.parse(source).children;
  const only = paragraph?.type === "paragraph" ? paragraph.children : [];
  return (
    rest.length === 0 &&
    only.length === 1 &&
    only[0]?.type === "text" &&
    only[0].value === value
  );
}
const supported = new Set([
  "root",
  "paragraph",
  "heading",
  "text",
  "strong",
  "emphasis",
  "delete",
  "inlineCode",
  "link",
  "image",
  "list",
  "listItem",
  "blockquote",
  "code",
  "table",
  "tableRow",
  "tableCell",
  "thematicBreak",
  "break",
]);

/** Keys that change how a node is spelled, not what it means. */
const ignored = ["position", "spread", "data", "autolink", "spaces"];

function meaning(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(meaning);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .filter(
          ([key, value]) =>
            !ignored.includes(key) && value !== null && value !== undefined,
        )
        .map(([key, value]) => [key, meaning(value)]),
    );
  }
  return node;
}

/**
 * Whether two trees mean the same thing: `meaning(a)` equals `meaning(b)`, without building
 * either copy. Keys compare in any order: Plate marks are written in the order they were nested.
 */
function sameMeaning(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((item, index) => sameMeaning(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const entries = (node: object) =>
      Object.entries(node).filter(
        ([key, value]) =>
          !ignored.includes(key) && value !== null && value !== undefined,
      );
    const left = entries(a);
    const right = new Map(entries(b));
    return (
      left.length === right.size &&
      left.every(
        ([key, value]) => right.has(key) && sameMeaning(value, right.get(key)),
      )
    );
  }
  return a === b;
}

/** What a construct the rich editor cannot keep is called, in plain words. */
const unsupportedNames: Record<string, string> = {
  html: "raw HTML",
  definition: "link definitions",
  linkReference: "reference-style links",
  imageReference: "reference-style images",
  footnoteDefinition: "footnotes",
  footnoteReference: "footnotes",
  yaml: "front matter",
};

/**
 * Why the rich editor would change this text, as short phrases ("raw HTML",
 * "a code fence with metadata"). The editor says them in one caption.
 */
function scan(
  node: Root | RootContent | PhrasingContent,
  reasons: Set<string>,
) {
  if (!supported.has(node.type))
    reasons.add(unsupportedNames[node.type] ?? "Markdown it cannot show");
  if (node.type === "code" && node.meta)
    reasons.add("a code fence with metadata");
  if ("children" in node)
    node.children.forEach((child) => scan(child, reasons));
}

function convert(
  node: RootContent | PhrasingContent,
  source: string,
): Descendant {
  switch (node.type) {
    case "text":
      return { text: node.value };
    case "inlineCode":
      return { text: node.value, code: true };
    case "strong":
    case "emphasis":
    case "delete": {
      const key = {
        strong: "bold",
        emphasis: "italic",
        delete: "strikethrough",
      }[node.type];
      const children = inline(node.children, source);
      // Nested inline marks apply to every leaf, including leaves in links.
      function mark(child: Descendant): Descendant {
        if (TextApi.isText(child)) return { ...child, [key]: true };
        // A break or picture has no text to style.
        if (child.type === "br" || child.type === "img") return child;
        return { ...child, children: child.children.map(mark) };
      }
      return { type: "inline-group", children: children.map(mark) };
    }
    case "link": {
      const only = node.children.length === 1 ? node.children[0] : undefined;
      // A URL typed in prose, with no `<>` or `[]()` around it, is written back the same way.
      const bare =
        only?.type === "text" &&
        source.slice(node.position?.start.offset, node.position?.end.offset) ===
          only.value;
      return {
        type: "a",
        url: node.url,
        title: node.title ?? "",
        ...(bare ? { autolink: "bare" } : {}),
        children: inline(node.children, source),
      };
    }
    case "break": {
      // Two trailing spaces and a backslash both break the line; keep the one the author used.
      const spaces = !source
        .slice(node.position?.start.offset, node.position?.end.offset)
        .startsWith("\\");
      return {
        type: "br",
        ...(spaces ? { spaces: true } : {}),
        children: [{ text: "" }],
      };
    }
    case "image":
      // An inline void: the editor shows the picture (or its label) as one unit.
      return {
        type: "img",
        url: node.url,
        alt: node.alt ?? "",
        title: node.title ?? "",
        children: [{ text: "" }],
      };
    case "code": {
      if (node.lang === "mermaid") {
        const raw = source.slice(
          node.position?.start.offset,
          node.position?.end.offset,
        );
        const firstNewline = raw.indexOf("\n");
        const body = firstNewline < 0 ? "" : raw.slice(firstNewline + 1);
        const opening = raw.match(/^[ \t]*(`{3,}|~{3,})/);
        const fence = opening?.[1] ?? "```";
        const closing = new RegExp(
          `(?:\\r?\\n|^)[ \\t]*${fence[0]}{${fence.length},}[ \\t]*$`,
        );
        // One final newline separates the code from its closing fence; it is
        // Markdown syntax, not part of the editable Mermaid source.
        const exact = body.replace(closing, "");
        return { type: "mermaid", source: exact, children: [{ text: "" }] };
      }
      return {
        type: "code_block",
        lang: node.lang ?? "",
        children: node.value
          .split("\n")
          .map((text) => ({ type: "code_line", children: [{ text }] })),
      };
    }
    case "paragraph":
      return { type: "p", children: inline(node.children, source) };
    case "heading":
      return {
        type: `h${node.depth}`,
        children: inline(node.children, source),
      };
    case "blockquote":
      return {
        type: "blockquote",
        children: node.children.map((child) => convert(child, source)),
      };
    case "list":
      return {
        type: node.ordered
          ? "ol"
          : node.children.every((child) => typeof child.checked === "boolean")
            ? "taskList"
            : "ul",
        start: node.start ?? 1,
        // A blank line between items; a list that had one keeps it.
        ...(node.spread ? { spread: true } : {}),
        children: node.children.map((child) => convert(child, source)),
      };
    case "listItem":
      return {
        type: "li",
        ...(node.checked === null || node.checked === undefined
          ? {}
          : { checked: node.checked }),
        ...(node.spread ? { spread: true } : {}),
        children: node.children.map((child) =>
          child.type === "paragraph"
            ? { type: "lic", children: inline(child.children, source) }
            : convert(child, source),
        ),
      };
    case "table":
      return {
        type: "table",
        align: node.align ?? [],
        children: node.children.map((row, index) => ({
          type: "tr",
          children: row.children.map((cell) => ({
            type: index === 0 ? "th" : "td",
            children: [{ type: "p", children: inline(cell.children, source) }],
          })),
        })),
      };
    case "thematicBreak":
      return { type: "hr", children: [{ text: "" }] };
    default:
      return { type: "p", children: [{ text: "" }] };
  }
}

function inline(nodes: PhrasingContent[], source: string): Descendant[] {
  const result = nodes.flatMap((node) => {
    const converted = convert(node, source);
    return !TextApi.isText(converted) && converted.type === "inline-group"
      ? converted.children
      : [converted];
  });
  return result.length ? result : [{ text: "" }];
}

type Mark = "italic" | "bold" | "strikethrough";
/** Outermost first: when two marks cover the same text, the earlier one wraps the later. */
const marks: Mark[] = ["italic", "bold", "strikethrough"];
const markNode = {
  italic: "emphasis",
  bold: "strong",
  strikethrough: "delete",
} as const;

/** The marks that cover all of this node's text. */
function marksOf(node: Descendant): Set<Mark> {
  if (TextApi.isText(node)) return new Set(marks.filter((mark) => node[mark]));
  if (node.type === "br" || node.type === "img" || !node.children.length)
    return new Set();
  const [first, ...rest] = node.children.map(marksOf);
  return new Set(
    [...(first ?? [])].filter((mark) => rest.every((set) => set.has(mark))),
  );
}

/** Whether `mark` covers the node at `index`; a line break inside a marked run is covered too. */
function covers(nodes: Descendant[], index: number, mark: Mark): boolean {
  const node = nodes[index];
  if (!node) return false;
  if (!TextApi.isText(node) && node.type === "br") {
    const before = nodes[index - 1];
    const after = nodes[index + 1];
    return (
      !!before &&
      !!after &&
      marksOf(before).has(mark) &&
      marksOf(after).has(mark)
    );
  }
  return marksOf(node).has(mark);
}

/**
 * Plate marks sit on each text leaf; Markdown nests them. Leaves that share a mark share one
 * wrapper, so `**a *b* c**` stays one strong holding an emphasis, not three strongs.
 * `outside` holds the marks already written by an enclosing wrapper.
 */
function phrasing(
  nodes: Descendant[],
  outside: ReadonlySet<Mark> = new Set(),
): PhrasingContent[] {
  const kept = nodes.filter(
    (node) => !TextApi.isText(node) || node.text !== "" || node.code,
  );
  const result: PhrasingContent[] = [];
  let index = 0;
  while (index < kept.length) {
    const node = kept[index];
    if (!node) break;
    const own = marks.filter(
      (mark) => marksOf(node).has(mark) && !outside.has(mark),
    );
    // Wrap the mark that runs longest from here, so wrappers nest instead of splitting.
    let best: { mark: Mark; end: number } | undefined;
    for (const mark of own) {
      let end = index + 1;
      while (end < kept.length && covers(kept, end, mark)) end += 1;
      if (!best || end > best.end) best = { mark, end };
    }
    if (best) {
      result.push({
        type: markNode[best.mark],
        children: phrasing(
          kept.slice(index, best.end),
          new Set([...outside, best.mark]),
        ),
      });
      index = best.end;
      continue;
    }
    result.push(...unmarked(kept, index, outside));
    index += 1;
  }
  return result;
}

/** A node that has no mark left to write. */
function unmarked(
  nodes: Descendant[],
  index: number,
  outside: ReadonlySet<Mark>,
): PhrasingContent[] {
  const node = nodes[index];
  if (!node) return [];
  if (TextApi.isText(node))
    return [
      node.code
        ? { type: "inlineCode", value: node.text }
        : { type: "text", value: node.text },
    ];
  if (node.type === "br")
    return [
      { type: "break", ...(node.spaces ? { data: { spaces: true } } : {}) },
    ];
  if (node.type === "img")
    return [
      {
        type: "image",
        url: String(node.url ?? ""),
        alt: String(node.alt ?? ""),
        title: String(node.title ?? "") || null,
      },
    ];
  if (node.type === "a") {
    const children = phrasing(node.children, outside);
    const label = children[0]?.type === "text" ? children[0].value : "";
    const url = String(node.url ?? "");
    const title = String(node.title ?? "") || null;
    const before = nodes[index - 1];
    const after = nodes[index + 1];
    // Bare only when nothing glues to it: `https://a.comx` would be another address.
    const bare =
      node.autolink === "bare" &&
      !title &&
      outside.size === 0 &&
      children.length === 1 &&
      (label === url ||
        url === `mailto:${label}` ||
        url === `http://${label}`) &&
      /^[^\s|<>`\\]*[^\s|<>`\\.,:;!?*_~)]$/.test(label) &&
      (!before || !TextApi.isText(before) || /[\s(]$/.test(before.text)) &&
      (!after || !TextApi.isText(after) || /^[\s,.;:!?)]/.test(after.text));
    return [
      {
        type: "link",
        url,
        title,
        ...(bare ? { data: { autolink: "bare" as const } } : {}),
        children,
      },
    ];
  }
  return phrasing(node.children, outside);
}

/** Leading and trailing spaces in a line are not Markdown content; remark would store them as `&#x20;`. */
function trimEdges(nodes: PhrasingContent[]): PhrasingContent[] {
  const result = [...nodes];
  const first = result[0];
  if (first?.type === "text") {
    const value = first.value.replace(/^[ \t]+/, "");
    if (value) result[0] = { ...first, value };
    else result.shift();
  }
  const last = result[result.length - 1];
  if (last?.type === "text") {
    const value = last.value.replace(/[ \t]+$/, "");
    if (value) result[result.length - 1] = { ...last, value };
    else result.pop();
  }
  return result;
}

const isBlank = (node: TElement) =>
  node.type === "p" &&
  node.children.every((child) => TextApi.isText(child) && !child.text.trim());

function block(node: TElement, diagrams: string[]): RootContent {
  const children = () =>
    node.children
      .filter((child): child is TElement => !TextApi.isText(child))
      .map((child) => block(child, diagrams));
  if (/^h[1-6]$/.test(node.type))
    return {
      type: "heading",
      depth: Number(node.type[1]) as 1 | 2 | 3 | 4 | 5 | 6,
      children: trimEdges(phrasing(node.children)),
    };
  switch (node.type) {
    case "blockquote":
      return {
        type: "blockquote",
        children: children() as import("mdast").BlockContent[],
      };
    case "ul":
    case "taskList":
    case "ol":
      return {
        type: "list",
        ordered: node.type === "ol",
        start: node.type === "ol" ? Number(node.start ?? 1) : null,
        spread: node.spread === true,
        children: children() as import("mdast").ListItem[],
      };
    case "li":
      return {
        type: "listItem",
        checked: typeof node.checked === "boolean" ? node.checked : null,
        spread: node.spread === true,
        children: children() as import("mdast").BlockContent[],
      };
    case "code_block":
      return {
        type: "code",
        lang: String(node.lang ?? "") || null,
        value: codeBlockText(node),
      };
    case "mermaid": {
      const index = diagrams.push(String(node.source ?? "")) - 1;
      return {
        type: "code",
        lang: "mermaid",
        value: `TICKETD_DIAGRAM_${index}_SOURCE`,
      };
    }
    case "hr":
      return { type: "thematicBreak" };
    case "table":
      return {
        type: "table",
        align: Array.isArray(node.align) ? node.align : [],
        children: node.children
          .filter((child): child is TElement => !TextApi.isText(child))
          .map((row) => ({
            type: "tableRow",
            children: row.children
              .filter((child): child is TElement => !TextApi.isText(child))
              .map((cell) => ({
                type: "tableCell",
                children: phrasing(cell.children),
              })),
          })),
      };
    default:
      return {
        type: "paragraph",
        children: trimEdges(phrasing(node.children)),
      };
  }
}

/** The canonical Markdown of these blocks, written together. */
function stringifyBlocks(blocks: TElement[]): string {
  const diagrams: string[] = [];
  const tree: Root = {
    type: "root",
    children: blocks.map((node) => block(node, diagrams)),
  };
  relaxed = false;
  let result = lenient.stringify(tree);
  if (relaxed) {
    // Unescaped neighbours can combine into syntax (`a*` before emphasis); keep the
    // standard output unless both spellings mean the same thing.
    const standard = processor.stringify(tree);
    if (!sameMeaning(processor.parse(result), processor.parse(standard)))
      result = standard;
  }
  diagrams.forEach((source, index) => {
    const longest = Math.max(
      2,
      ...Array.from(source.matchAll(/`+/g), (match) => match[0].length),
    );
    const fence = "`".repeat(longest + 1);
    result = result.replace(
      `\`\`\`mermaid\nTICKETD_DIAGRAM_${index}_SOURCE\n\`\`\``,
      () => `${fence}mermaid\n${source}\n${fence}`,
    );
  });
  // Stringification ends every document with a newline; stored text does not.
  return result.replace(/\n$/, "");
}

/**
 * The Markdown a rich value was read from, block by block. A block the editor has not changed
 * is written as its own text, so a rich edit rewrites only the blocks it touched. `start` and
 * `end` locate a block in `source`; a block without them is written from the rich value.
 */
export interface Baseline {
  source: string;
  blocks: Array<{
    node: TElement;
    span?: { start: number; end: number };
  }>;
}

function sameNode(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameNode(item, b[index]))
    );
  const left = Object.entries(a);
  return (
    left.length === Object.keys(b).length &&
    left.every(([key, value]) => key in b && sameNode(value, (b as never)[key]))
  );
}

/** For each block, the baseline block with the same content and text in `source`, or -1. */
function matchBlocks(blocks: TElement[], from: Baseline): number[] {
  let cursor = 0;
  return blocks.map((node) => {
    for (let index = cursor; index < from.blocks.length; index += 1) {
      const candidate = from.blocks[index];
      if (candidate?.span && sameNode(candidate.node, node)) {
        cursor = index + 1;
        return index;
      }
    }
    return -1;
  });
}

const isList = (node: TElement) =>
  node.type === "ul" || node.type === "ol" || node.type === "taskList";
/** Only blank space and line breaks between two blocks. */
const separator = /^[ \t]*(?:\r?\n[ \t]*)+$/;

/**
 * The sole rich-to-storage boundary: emits CommonMark/GFM, never editor JSON/MDX.
 * With the `from` the value was read from, blocks it did not change keep their own text and
 * spacing; without it every block is written in the canonical form.
 */
export function writeMarkdownFrom(
  value: Value,
  from?: Baseline,
): { markdown: string; baseline: Baseline } {
  // Empty paragraphs (Enter pressed twice) are spacing, not content.
  const blocks = value.filter((node) => !isBlank(node));
  const canonical = () => {
    const markdown = stringifyBlocks(blocks);
    return {
      markdown,
      baseline: { source: markdown, blocks: blocks.map((node) => ({ node })) },
    };
  };
  const matched = from ? matchBlocks(blocks, from) : [];
  if (!from || matched.every((index) => index < 0)) return canonical();

  // Unchanged blocks are kept; each run of changed blocks is written together.
  const pieces: Array<{ kept?: number; blocks: TElement[] }> = [];
  for (let index = 0; index < blocks.length;) {
    const kept = matched[index] ?? -1;
    let end = index + 1;
    if (kept < 0)
      while (end < blocks.length && (matched[end] ?? -1) < 0) end += 1;
    pieces.push({
      ...(kept >= 0 ? { kept } : {}),
      blocks: blocks.slice(index, end),
    });
    index = end;
  }
  let markdown = "";
  const written: Baseline["blocks"] = [];
  let previous: (typeof pieces)[number] | undefined;
  for (const piece of pieces) {
    const span =
      piece.kept === undefined ? undefined : from.blocks[piece.kept]?.span;
    const text = span
      ? from.source.slice(span.start, span.end)
      : stringifyBlocks(piece.blocks);
    if (previous) {
      // Kept neighbours keep the spacing they had: `Steps:` straight above its list.
      const before =
        previous.kept === undefined ? undefined : from.blocks[previous.kept];
      const gap =
        piece.kept !== undefined &&
        piece.kept === (previous.kept ?? -2) + 1 &&
        before?.span &&
        span
          ? from.source.slice(before.span.end, span.start)
          : "";
      const original = separator.test(gap);
      const last = previous.blocks[previous.blocks.length - 1];
      const first = piece.blocks[0];
      // Written next to each other, these would read as one list or as list content.
      if (
        !original &&
        last &&
        first &&
        isList(last) &&
        (isList(first) || (span && /^(?: {4}|\t)/.test(text)))
      )
        return canonical();
      markdown += original ? gap : "\n\n";
    }
    if (span) {
      const start = markdown.length;
      markdown += text;
      written.push({
        node: piece.blocks[0] as TElement,
        span: { start, end: markdown.length },
      });
    } else {
      markdown += text;
      written.push(...piece.blocks.map((node) => ({ node })));
    }
    previous = piece;
  }
  return { markdown, baseline: { source: markdown, blocks: written } };
}

export function writeMarkdown(value: Value, from?: Baseline): string {
  return writeMarkdownFrom(value, from).markdown;
}

/** What each block is called when the banner says which one the rich editor would rewrite. */
function blockName(node: TElement | undefined): string {
  if (!node) return "a block";
  if (/^h[1-6]$/.test(node.type)) return "a heading";
  return (
    {
      p: "a paragraph",
      ul: "a list",
      ol: "a list",
      taskList: "a list",
      blockquote: "a quote",
      code_block: "a code block",
      table: "a table",
      mermaid: "a diagram",
      hr: "a divider",
    }[node.type] ?? "a block"
  );
}

/** Adjacent text with the same marks is one run of text; Markdown cannot tell them apart. */
function runs(nodes: readonly Descendant[]): Descendant[] {
  const result: Descendant[] = [];
  for (const node of nodes) {
    const previous = result[result.length - 1];
    if (TextApi.isText(node)) {
      if (
        previous &&
        TextApi.isText(previous) &&
        sameMeaning({ ...previous, text: "" }, { ...node, text: "" })
      ) {
        result[result.length - 1] = {
          ...previous,
          text: previous.text + node.text,
        };
      } else result.push(node);
    } else result.push({ ...node, children: runs(node.children) });
  }
  return result;
}

/**
 * The rich value for `source`, why it must stay in source editing (if it must), `markdown`
 * (the text that value writes, which is `source`'s own text for what the editor has not
 * changed) and the `baseline` that keeps it so.
 */
export function readMarkdown(source: string) {
  const tree = processor.parse(source);
  const reasons = new Set<string>();
  scan(tree, reasons);
  const baseline: Baseline = { source, blocks: [] };
  const value: Value = [];
  for (const node of tree.children) {
    const converted = convert(node, source);
    if (TextApi.isText(converted)) continue;
    value.push(converted);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    baseline.blocks.push({
      node: converted,
      ...(start === undefined || end === undefined
        ? {}
        : { span: { start, end } }),
    });
  }
  if (!value.length) value.push({ type: "p", children: [{ text: "" }] });
  const markdown = writeMarkdown(value, baseline);
  if (!reasons.size && source.trim()) {
    // The editor writes a block it changes in its own canonical form. If that form would
    // mean something else, say which block, and keep the text in source editing.
    const canonical = stringifyBlocks(value);
    if (canonical !== source && `${canonical}\n` !== source) {
      const reread = processor
        .parse(canonical)
        .children.map((node) => convert(node, canonical))
        .filter((node): node is TElement => !TextApi.isText(node));
      const before = runs(value);
      const after = runs(reread);
      const changed = before.findIndex(
        (node, index) => !sameMeaning(node, after[index]),
      );
      if (changed >= 0 || before.length !== after.length) {
        const line = tree.children[changed]?.position?.start.line;
        reasons.add(
          changed >= 0
            ? `${blockName(value[changed])}${line ? ` at line ${line}` : ""} it would rewrite`
            : "Markdown it would rewrite",
        );
      }
    }
  }
  return {
    value,
    reasons: [...reasons],
    markdown,
    baseline,
    /** The tree's meaning, built only when asked for. */
    get meaning() {
      return meaning(tree);
    },
  };
}

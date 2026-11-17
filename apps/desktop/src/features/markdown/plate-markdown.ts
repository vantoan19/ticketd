import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import { TextApi, type Descendant, type TElement, type Value } from "platejs";
import type { Root, RootContent, PhrasingContent } from "mdast";

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
} as const;
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, stringifyOptions);

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

function meaning(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(meaning);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .filter(
          ([key, value]) =>
            !["position", "spread", "data"].includes(key) &&
            value !== null &&
            value !== undefined,
        )
        .map(([key, value]) => [key, meaning(value)]),
    );
  }
  return node;
}

/**
 * Whether two trees mean the same thing: `JSON.stringify(meaning(a)) === JSON.stringify(meaning(b))`
 * without building either copy. Keys compare in order, as the JSON text would.
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
          !["position", "spread", "data"].includes(key) &&
          value !== null &&
          value !== undefined,
      );
    const left = entries(a);
    const right = entries(b);
    return (
      left.length === right.length &&
      left.every(
        ([key, value], index) =>
          right[index]?.[0] === key && sameMeaning(value, right[index]?.[1]),
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
        return TextApi.isText(child)
          ? { ...child, [key]: true }
          : { ...child, children: child.children.map(mark) };
      }
      return { type: "inline-group", children: children.map(mark) };
    }
    case "link":
      return {
        type: "a",
        url: node.url,
        title: node.title ?? "",
        children: inline(node.children, source),
      };
    case "break":
      return { type: "br", children: [{ text: "" }] };
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
        children: node.children.map((child) => convert(child, source)),
      };
    case "listItem":
      return {
        type: "li",
        ...(node.checked === null || node.checked === undefined
          ? {}
          : { checked: node.checked }),
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

function phrasing(nodes: Descendant[]): PhrasingContent[] {
  return nodes.flatMap((node): PhrasingContent[] => {
    if (TextApi.isText(node)) {
      let result: PhrasingContent = node.code
        ? { type: "inlineCode", value: node.text }
        : { type: "text", value: node.text };
      if (node.bold) result = { type: "strong", children: [result] };
      if (node.italic) result = { type: "emphasis", children: [result] };
      if (node.strikethrough) result = { type: "delete", children: [result] };
      return [result];
    }
    if (node.type === "br") return [{ type: "break" }];
    if (node.type === "img")
      return [
        {
          type: "image",
          url: String(node.url ?? ""),
          alt: String(node.alt ?? ""),
          title: String(node.title ?? "") || null,
        },
      ];
    if (node.type === "a")
      return [
        {
          type: "link",
          url: String(node.url ?? ""),
          title: String(node.title ?? "") || null,
          children: phrasing(node.children),
        },
      ];
    return phrasing(node.children);
  });
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
        spread: false,
        children: children() as import("mdast").ListItem[],
      };
    case "li":
      return {
        type: "listItem",
        checked: typeof node.checked === "boolean" ? node.checked : null,
        spread: false,
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

/** The sole rich-to-storage boundary: emits CommonMark/GFM, never editor JSON/MDX. */
export function writeMarkdown(value: Value): string {
  const diagrams: string[] = [];
  const tree: Root = {
    type: "root",
    // Empty paragraphs (Enter pressed twice) are spacing, not content.
    children: value
      .filter((node) => !isBlank(node))
      .map((node) => block(node, diagrams)),
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
 * The rich value for `source`, why it must stay in source editing (if it must), and `markdown`:
 * the canonical text the rich value writes, so callers need not write it again.
 */
export function readMarkdown(source: string) {
  const tree = processor.parse(source);
  const reasons = new Set<string>();
  scan(tree, reasons);
  const value: Value = tree.children
    .map((node) => convert(node, source))
    .filter((node): node is TElement => !TextApi.isText(node));
  if (!value.length) value.push({ type: "p", children: [{ text: "" }] });
  const markdown = writeMarkdown(value);
  if (
    !reasons.size &&
    source.trim() &&
    // Identical text needs no second parse to mean the same thing.
    markdown !== source &&
    !sameMeaning(processor.parse(markdown), tree)
  ) {
    reasons.add("Markdown it would rewrite");
  }
  return {
    value,
    reasons: [...reasons],
    markdown,
    /** The tree's meaning, built only when asked for. */
    get meaning() {
      return meaning(tree);
    },
  };
}

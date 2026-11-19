import { describe, expect, it } from "vitest";
import {
  readMarkdown,
  writeMarkdown,
  writeMarkdownFrom,
} from "./plate-markdown";

describe("canonical Markdown rich-edit boundary", () => {
  it("keeps attachment links inline in prose, standalone paragraphs, lists and tables with literal labels", () => {
    const uri = "ticketd://attachment/workspace-id/file-id";
    const link = `[Trace [final] 日本語](${uri})`;
    const source = `Before ${link} after.\n\n${link}\n\n- ${link}\n\n| File |\n| --- |\n| ${link} |`;
    const document = readMarkdown(source);
    expect(document.reasons).toEqual([]);
    const saved = writeMarkdown(document.value);
    expect(readMarkdown(saved).meaning).toEqual(document.meaning);
    expect(saved.match(/ticketd:\/\/attachment\//g)).toHaveLength(4);
    expect(saved).toContain("Trace [final] 日本語");
  });
  it("edits attachment images and mixed checklists richly, keeping their Markdown (R3.4)", () => {
    const uri = "ticketd://attachment/workspace-id/file-id";
    // The shape agents write: bullets and checkboxes in one list, then an image.
    const source = `Steps:\n\n- Reproduce with 10+ cards\n- [ ] Measure layout shift\n- [x] Record a video\n\n![Board icon](${uri} "Before")`;
    const document = readMarkdown(source);
    expect(document.reasons).toEqual([]);
    const written = writeMarkdown(document.value);
    expect(readMarkdown(written).meaning).toEqual(document.meaning);
    expect(written).toBe(source);
  });
  it("retains nested lists, checklist state, links, Unicode, table escapes and code languages", () => {
    const source = `# Plan 日本語\n\nA **bold** and *soft* [link](https://example.com "Title") with ~~old~~ and \`code\`.\n\n3. first\n   - nested\n   - second\n4. next\n\n- [x] done\n- [ ] later\n\n| Name | Value |\n| :--- | ---: |\n| a\\|b | café |\n\n\`\`\`rust\nlet value = 1;\n\`\`\`\n`;
    const document = readMarkdown(source);
    expect(document.reasons).toEqual([]);
    const written = writeMarkdown(document.value);
    expect(readMarkdown(written).meaning).toEqual(document.meaning);
    expect(written).toContain("a\\|b");
    expect(written).toContain("```rust");
    expect(written).toContain("- [x] done");
  });
  it("routes HTML, comments, references and fence metadata to source without losing the string", () => {
    for (const [source, reason] of [
      ["<aside>raw</aside>", "raw HTML"],
      ["<!-- comment -->", "raw HTML"],
      ["[link][id]\n\n[id]: /path", "reference-style links"],
      ["```rust title=demo\nvalue\n```", "a code fence with metadata"],
      ["<Widget />", "raw HTML"],
    ] as const) {
      expect(readMarkdown(source).reasons).toContain(reason);
    }
    expect(
      readMarkdown("```unknown-language\nraw <input> 日本語\n```\n").reasons,
    ).toEqual([]);
  });

  it("returns the Markdown it already wrote, so a caller need not write it again", () => {
    for (const source of [
      "###   Keep exact opening source\n\n- [x] Done\n\n3. Third\n",
      "Status [WIP] - 5 * 3, see snake_case_name",
      "<aside>raw</aside>\n\nText",
      "",
    ]) {
      const document = readMarkdown(source);
      expect(document.markdown).toBe(
        writeMarkdown(document.value, document.baseline),
      );
    }
  });

  it("retains exact Mermaid source including CRLF and invalid syntax across another rich edit", () => {
    const source =
      "before\r\n\r\n```mermaid\r\ngraph TD;\r\n A --> \r\n```\r\n";
    const document = readMarkdown(source);
    expect(document.reasons).toEqual([]);
    expect(document.value[1]?.source).toBe("graph TD;\r\n A --> ");
    const written = writeMarkdown(document.value);
    expect(written).toContain("```mermaid\ngraph TD;\r\n A --> \n```");
  });
  it("preserves replacement tokens in loaded and edited Mermaid source", () => {
    const original = 'graph TD\n A["$$ $& $` $\' 日本語"] --> B\r\n';
    const loaded = readMarkdown(
      `before\n\n\`\`\`mermaid\n${original}\n\`\`\`\n`,
    );
    expect(loaded.reasons).toEqual([]);
    expect(readMarkdown(writeMarkdown(loaded.value)).value[1]?.source).toBe(
      original,
    );
    const edited = original + ' B["$& $$ $\' $`"] --> C\n';
    const diagram = loaded.value[1];
    if (!diagram) throw new Error("Expected a Mermaid diagram");
    diagram.source = edited;
    expect(readMarkdown(writeMarkdown(loaded.value)).value[1]?.source).toBe(
      edited,
    );
  });
  it("preserves an edited diagram's exact terminal newlines when reopened", () => {
    for (const source of [
      "graph TD\r\n A -->",
      "graph TD\n A --> B\n",
      "graph TD\n A --> B\n\n",
      "",
    ]) {
      const value = [{ type: "mermaid", source, children: [{ text: "" }] }];
      expect(readMarkdown(writeMarkdown(value)).value[0]?.source).toBe(source);
    }
  });
});

describe("Markdown writing keeps text as typed", () => {
  const rich = (text: string) => [{ type: "p", children: [{ text }] }];
  it("does not escape punctuation that is not syntax and adds no trailing newline", () => {
    for (const text of [
      "2*3 [brackets] and a_b",
      "snake_case_name and v1.2",
      "Done. See step 2.",
    ])
      expect(writeMarkdown(rich(text))).toBe(text);
  });
  it("keeps only the escape that prevents emphasis", () => {
    expect(writeMarkdown(rich("2*3*4 [x]"))).toBe("2*3\\*4 [x]");
  });
  it("still escapes text that would otherwise change meaning", () => {
    for (const text of ["*not emphasis*", "1. not a list", "# not a heading"]) {
      const written = writeMarkdown(rich(text));
      expect(written).not.toBe(text);
      expect(readMarkdown(written).value).toEqual(rich(text));
    }
  });
  it("round trips a brief without rewriting it", () => {
    const brief = "Fixed 3. items and [x] later";
    expect(writeMarkdown(readMarkdown(brief).value)).toBe(brief);
  });
});

describe("typed text is stored as typed", () => {
  const p = (...texts: string[]) =>
    texts.map((text) => ({ type: "p", children: [{ text }] }));
  const cases: Array<[string, string[], string]> = [
    [
      "mid-line number and period",
      ["Fixed 5. first line"],
      "Fixed 5. first line",
    ],
    [
      "intraword underscores",
      ["_under_score_ and a_b_c"],
      "_under_score\\_ and a_b_c",
    ],
    ["intraword underscores only", ["snake_case_name"], "snake_case_name"],
    [
      "angle brackets that are not HTML",
      ["a < b and 3 > 2"],
      "a < b and 3 > 2",
    ],
    ["checkbox-like brackets", ["done [x] later"], "done [x] later"],
    // CommonMark reads 2*3*4 as emphasis, so the single backslash is the minimum that round-trips.
    ["star between digits", ["2*3*4"], "2*3\\*4"],
    ["leading spaces in a paragraph", ["  hello"], "hello"],
    ["leading space after heading marker", ["DRAFT"], "DRAFT"],
    [
      "Enter twice makes no extra blank lines",
      ["one", "", "two"],
      "one\n\ntwo",
    ],
    ["trailing empty paragraph", ["one", ""], "one"],
  ];
  for (const [name, texts, expected] of cases)
    it(name, () => {
      const value = p(...texts);
      const stored = writeMarkdown(value);
      expect(stored).toBe(expected);
      expect(stored).not.toContain("&#x20;");
      expect(writeMarkdown(readMarkdown(stored).value)).toBe(stored);
    });
  it("heading with leading space does not store an entity", () => {
    const stored = writeMarkdown([
      { type: "h1", children: [{ text: " DRAFT" }] },
    ]);
    expect(stored).toBe("# DRAFT");
  });
  it("literal asterisk emphasis characters stay literal when they round trip", () => {
    const stored = writeMarkdown(p("*line*"));
    expect(readMarkdown(stored).value).toEqual(p("*line*"));
  });
  it("does not escape the colon of a typed URL", () => {
    expect(writeMarkdown(p("See https://example.org/x now"))).toBe(
      "See https://example.org/x now",
    );
  });
});

/** Types `text` over the first text in a block, as an edit inside it would. */
function retext(node: unknown, text: string) {
  let current = node as { children?: unknown[]; text?: string } | undefined;
  while (current?.children)
    current = current.children[0] as typeof current | undefined;
  if (!current) throw new Error("Expected a text node");
  current.text = text;
}

/** What the editor saves after a change elsewhere in the document: text added after, and before. */
function afterUnrelatedEdits(source: string) {
  const document = readMarkdown(source);
  const paragraph = (text: string) => ({ type: "p", children: [{ text }] });
  return [
    writeMarkdown([...document.value, paragraph("After")], document.baseline),
    writeMarkdown([paragraph("Before"), ...document.value], document.baseline),
  ];
}

describe("nested inline marks stay in rich editing (editor-1)", () => {
  const sources = [
    "Run **`npm test` first** please",
    "**bold *italic* bold**",
    "**bold [link](https://a.com) bold**",
    "*italic **bold** italic*",
    "***both***",
    "**a  \nb**",
    "# **Head** `code`",
    "- **a `b`**\n- c",
  ];
  it.each(sources)("%j needs no source editing and round trips", (source) => {
    const document = readMarkdown(source);
    expect(document.reasons).toEqual([]);
    expect(document.markdown).toBe(source);
    // The canonical writer itself keeps the nesting, for the block a person edits.
    expect(writeMarkdown(document.value)).toBe(source);
    expect(afterUnrelatedEdits(source)).toEqual([
      `${source}\n\nAfter`,
      `Before\n\n${source}`,
    ]);
  });
  it("writes one wrapper around leaves that share a mark, not one per leaf", () => {
    const leaf = (text: string, marks: object = {}) => ({ text, ...marks });
    const written = writeMarkdown([
      {
        type: "p",
        children: [
          leaf("bold ", { bold: true }),
          leaf("both", { bold: true, italic: true }),
          leaf(" bold", { bold: true }),
        ],
      },
    ]);
    expect(written).toBe("**bold *both* bold**");
  });
  it("treats marks nested in the other order as the same text", () => {
    expect(readMarkdown("~~**x**~~ and **~~y~~**").reasons).toEqual([]);
  });
});

describe("a rich edit does not rewrite link destinations, breaks or bare URLs (editor-2)", () => {
  const sources = [
    "Link [x](https://a.com/?a=1&b=2&c=3) end",
    "[w](https://en.wikipedia.org/wiki/Foo_(bar))",
    '[t](https://a.com/x "Title")',
    "[s](<https://a.com/a b>)",
    "line one  \nline two",
    "line one\\\nline two",
    "see https://example.com/a_b, ok",
    "(https://example.com)",
    "mail a@b.co ok",
    "see www.example.com/a_b ok",
    "<https://a.com/?a=1&b=2>",
  ];
  it.each(sources)("%j", (source) => {
    const document = readMarkdown(source);
    expect(document.reasons).toEqual([]);
    expect(writeMarkdown(document.value)).toBe(source);
    expect(afterUnrelatedEdits(source)).toEqual([
      `${source}\n\nAfter`,
      `Before\n\n${source}`,
    ]);
  });
  it("still escapes what a destination needs", () => {
    for (const url of [
      "https://a.com/x)y(z",
      "https://a.com/?q=&amp;",
      "https://a.com/a b",
      "https://a.com/a\\(b",
    ]) {
      const value = [
        {
          type: "p",
          children: [{ type: "a", url, children: [{ text: "t" }] }],
        },
      ];
      const reread = readMarkdown(writeMarkdown(value)).value[0];
      expect(reread?.children).toMatchObject([{ type: "a", url }]);
    }
  });
  it("does not glue text onto a bare URL", () => {
    const value = [
      {
        type: "p",
        children: [
          { text: "" },
          {
            type: "a",
            url: "https://a.com",
            autolink: "bare",
            children: [{ text: "https://a.com" }],
          },
          { text: "x" },
        ],
      },
    ];
    const written = writeMarkdown(value);
    expect(written).toBe("<https://a.com>x");
    expect(readMarkdown(written).value[0]?.children).toMatchObject([
      { type: "a", url: "https://a.com" },
      { text: "x" },
    ]);
  });
});

describe("a rich edit keeps the spelling of blocks it did not touch (editor-3)", () => {
  const sources = [
    "a\n\n***\n\nb",
    "a\n\n___\n\nb",
    "- one\n\n- two",
    "1. a\n1. b",
    "3) a\n4) b",
    "* star\n* bar",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "| a |\n|---|\n| long cell |",
    "Steps:\n- x\n- y",
    "a\n\n\n\nb",
    "~~~\ncode\n~~~",
    "```mermaid\ngraph TD\n  A-->B\n```",
    "- a\n\n* b",
  ];
  it.each(sources)("%j", (source) => {
    const document = readMarkdown(source);
    expect(document.reasons).toEqual([]);
    expect(document.markdown).toBe(source);
    expect(afterUnrelatedEdits(source)).toEqual([
      `${source}\n\nAfter`,
      `Before\n\n${source}`,
    ]);
  });
  it("keeps the spacing between untouched neighbours and only the edited block changes", () => {
    const source = "Steps:\n- x\n- y\n\n\n---\n\nlast";
    const document = readMarkdown(source);
    const value = structuredClone(document.value);
    retext(value.at(-1), "edited");
    expect(writeMarkdown(value, document.baseline)).toBe(
      "Steps:\n- x\n- y\n\n\n---\n\nedited",
    );
  });
  it("writes a divider as --- and keeps a list loose in the canonical form", () => {
    expect(writeMarkdown([{ type: "hr", children: [{ text: "" }] }])).toBe(
      "---",
    );
    const loose = readMarkdown("- a\n\n- b");
    const value = structuredClone(loose.value);
    retext(value[0], "A");
    // Without the baseline the list is written in the canonical form, and it stays loose.
    expect(writeMarkdown(value)).toBe("- A\n\n- b");
  });
  it("never lets a kept list merge with an edited list next to it", () => {
    const document = readMarkdown("- a\n\n* b");
    const value = structuredClone(document.value);
    retext(value[1], "B");
    const written = writeMarkdown(value, document.baseline);
    expect(readMarkdown(written).value).toHaveLength(2);
  });
  it("hands the next write a baseline that matches what was written", () => {
    const document = readMarkdown("* a\n\n---\n\nb");
    const value = structuredClone(document.value);
    value.push({ type: "p", children: [{ text: "c" }] });
    const first = writeMarkdownFrom(value, document.baseline);
    value.push({ type: "p", children: [{ text: "d" }] });
    expect(writeMarkdown(value, first.baseline)).toBe(
      "* a\n\n---\n\nb\n\nc\n\nd",
    );
  });
});

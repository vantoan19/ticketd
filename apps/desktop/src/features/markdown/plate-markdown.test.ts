import { describe, expect, it } from "vitest";
import { readMarkdown, writeMarkdown } from "./plate-markdown";

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
    expect(
      readMarkdown(`![literal image label](${uri})`).reasons.length,
    ).toBeGreaterThan(0);
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
  it("routes HTML, comments, references, images and fence metadata to source without losing the string", () => {
    for (const source of [
      "<aside>raw</aside>",
      "<!-- comment -->",
      "[link][id]\n\n[id]: /path",
      "![alt](/image.png)",
      "```rust title=demo\nvalue\n```",
      "<Widget />",
    ]) {
      expect(readMarkdown(source).reasons.length).toBeGreaterThan(0);
    }
    expect(
      readMarkdown("```unknown-language\nraw <input> 日本語\n```\n").reasons,
    ).toEqual([]);
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

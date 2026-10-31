import { describe, expect, it } from "vitest";
import { readMarkdown, writeMarkdown } from "./plate-markdown";

describe("canonical Markdown rich-edit boundary", () => {
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

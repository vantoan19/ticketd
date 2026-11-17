import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { expect, test } from "vitest";
import { chunkFade } from "@/features/markdown/chunk-fade";

const html = (source: string, starts: number[]) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [[chunkFade, starts]],
      children: source,
    } as never),
  );

test("text before the first start stays plain; each later chunk is a span", () => {
  expect(html("Hello world, again", [])).toBe("<p>Hello world, again</p>");
  expect(html("Hello world, again", [5, 12])).toBe(
    '<p>Hello<span class="chat-chunk"> world,</span><span class="chat-chunk"> again</span></p>',
  );
});

test("a chunk keeps its span as more text arrives", () => {
  expect(html("Hello world", [5])).toBe(
    '<p>Hello<span class="chat-chunk"> world</span></p>',
  );
  expect(html("Hello world!", [5])).toBe(
    '<p>Hello<span class="chat-chunk"> world!</span></p>',
  );
});

test("chunks reach into emphasis and later paragraphs", () => {
  expect(html("a *b* c\n\nd", [2, 8])).toBe(
    '<p>a <em><span class="chat-chunk">b</span></em><span class="chat-chunk"> c</span></p>\n<p><span class="chat-chunk">d</span></p>',
  );
});

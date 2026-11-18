// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { LazySourceEditor, MarkdownEditor } from "./MarkdownEditor";

// Source mode's editor loads lazily (see SourceEditorLoading.test.tsx); load it
// up front so these tests can read it at once.
beforeAll(() => LazySourceEditor.preload());

afterEach(cleanup);

/** The CSS CodeMirror mounted for the source text that reads exactly `text`. */
function styleOf(source: HTMLElement, text: string) {
  const span = [...source.querySelectorAll("span")].find(
    (item) => item.textContent === text,
  );
  const classes = span ? [...span.classList] : [];
  return [...document.querySelectorAll("style")]
    .flatMap((style) => [...(style.sheet?.cssRules ?? [])])
    .map((rule) => rule.cssText)
    .filter((rule) => classes.some((name) => rule.startsWith(`.${name} `)))
    .join(" ");
}

it("colours source mode from the theme tokens, not CodeMirror's light palette", () => {
  render(
    <MarkdownEditor
      value={"## Problem\n\nSee [docs](https://x.dev)"}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  const source = screen.getByRole("textbox", {
    name: "Markdown document source",
  });
  const heading = styleOf(source, " Problem");
  expect(heading).toContain("var(--syntax-title)");
  expect(heading).not.toContain("underline");
  expect(styleOf(source, "##")).toContain("var(--syntax-comment)");
  expect(styleOf(source, "docs")).toContain("var(--link-foreground)");
});

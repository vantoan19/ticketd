// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";

// Source editing loads CodeMirror in its own chunk; each test starts with it unloaded.
beforeEach(() => vi.resetModules());
afterEach(() => {
  cleanup();
  vi.doUnmock("./SourceEditor");
});

async function openSource() {
  const { MarkdownEditor } = await import("./MarkdownEditor");
  const onChange = vi.fn();
  render(<MarkdownEditor value="Plain *text*" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  return onChange;
}

test("source mode shows the text while CodeMirror loads, then edits it", async () => {
  let release = () => {};
  const loaded = new Promise<void>((resolve) => (release = resolve));
  vi.doMock("./SourceEditor", async (original) => {
    await loaded;
    return original();
  });
  const onChange = await openSource();

  expect(screen.getByRole("status").textContent).toContain(
    "Loading source editor",
  );
  expect(screen.getByText("Plain *text*")).toBeTruthy();

  release();
  const source = await screen.findByRole("textbox", {
    name: "Markdown document source",
  });
  act(() => {
    const view = EditorView.findFromDOM(source);
    view?.dispatch({
      changes: { from: view.state.doc.length, insert: "!" },
      userEvent: "input.type",
    });
  });
  expect(onChange).toHaveBeenLastCalledWith("Plain *text*!");
});

test("a source editor that fails to load says so instead of going blank", async () => {
  vi.doMock("./SourceEditor", () => {
    throw new Error("Failed to fetch dynamically imported module");
  });
  await openSource();

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't load",
  );
});

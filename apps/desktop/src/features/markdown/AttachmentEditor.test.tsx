// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, afterAll, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { MarkdownEditor } from "./MarkdownEditor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const editableDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "isContentEditable",
);
beforeAll(() =>
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get() {
      return !!this.closest('[contenteditable="true"]');
    },
  }),
);
afterAll(() => {
  if (editableDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "isContentEditable",
      editableDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "isContentEditable");
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const file = {
  id: "file-1",
  display_name: "trace [final].log",
  original_filename: "trace.log",
  size_bytes: 12,
  kind: "local_snapshot",
  locator: "file-1/bytes/trace.log",
};
const uri = "ticketd://attachment/workspace-1/file-1";

test("inserts a stored file at the rich caret without rewriting on focus or mode changes", async () => {
  const changed = vi.fn();
  vi.mocked(open).mockResolvedValue("C:/trace.log");
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_uri" ? uri : file,
  );
  function Draft() {
    const [value, setValue] = useState("Before after");
    return (
      <MarkdownEditor
        persistentToolbar
        value={value}
        onChange={(next) => {
          setValue(next);
          changed(next);
        }}
      />
    );
  }
  render(<Draft />);
  const editable = screen.getByRole("textbox", {
    name: "Markdown document rich text",
  });
  Object.defineProperty(editable, "isContentEditable", { value: true });
  editable.focus();
  const text = screen.getByText("Before after").firstChild!;
  const range = document.createRange();
  range.setStart(text, 7);
  range.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent.select(editable);
  fireEvent(document, new Event("selectionchange"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Insert attachment" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      `Before [trace [final].log](${uri})after`,
    ),
  );
  const saved = changed.mock.lastCall?.[0];
  const count = changed.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  expect(
    screen.getByRole("textbox", { name: "Markdown document source" })
      .textContent,
  ).toContain(saved);
  fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
  expect(changed).toHaveBeenCalledTimes(count);
  expect(invoke).not.toHaveBeenCalledWith(
    "set_ticket_attachment",
    expect.anything(),
  );
});

test("a failed upload cannot insert a valid link and retry keeps the upload identity", async () => {
  const changed = vi.fn();
  vi.mocked(open).mockResolvedValue("C:/trace.log");
  let failed = true;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_uri") return uri;
    if (failed) throw new Error("Disk full");
    return file;
  });
  function Draft() {
    const [value, setValue] = useState("Draft");
    return (
      <MarkdownEditor
        persistentToolbar
        value={value}
        onChange={(next) => {
          setValue(next);
          changed(next);
        }}
      />
    );
  }
  render(<Draft />);
  fireEvent.click(screen.getByRole("button", { name: "Insert attachment" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
  await screen.findByRole("alert");
  expect(changed).not.toHaveBeenCalled();
  const original = vi
    .mocked(invoke)
    .mock.calls.find(([command]) => command === "import_attachment")?.[1];
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "import_attachment")
      .map(([, args]) => args),
  ).toEqual([original, original]);
});

test("source insertion reuses a stored identity while preserving image syntax and unsupported content", async () => {
  const original = `![literal image label](${uri})\n\n<!-- preserve this source -->`;
  const changed = vi.fn();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_uri" ? uri : file,
  );
  function Draft() {
    const [value, setValue] = useState(original);
    return (
      <MarkdownEditor
        value={value}
        onChange={(next) => {
          setValue(next);
          changed(next);
        }}
      />
    );
  }
  render(<Draft />);
  const source = screen.getByRole("textbox", {
    name: "Markdown document source",
  });
  source.focus();
  fireEvent.click(screen.getByRole("button", { name: "Insert attachment" }));
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Attachment ID" }), {
    target: { value: file.id },
  });
  fireEvent.click(screen.getByRole("button", { name: "Reuse ID" }));
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      `[trace [final].log](${uri})${original}`,
    ),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "import_attachment",
    expect.anything(),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "set_ticket_attachment",
    expect.anything(),
  );
});

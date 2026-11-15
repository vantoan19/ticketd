// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  expect,
  test,
  vi,
} from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { MarkdownEditor } from "./MarkdownEditor";
import { EditorView } from "@codemirror/view";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import type { Event as TauriEvent } from "@tauri-apps/api/event";

const nativeDrop = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: nativeDrop.listen }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = () => {};
    toJSON() {
      return "__CHANNEL__:1";
    }
  },
}));
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
const rangeGeometry = new Map([
  [
    "getClientRects",
    Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects"),
  ],
  [
    "getBoundingClientRect",
    Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect"),
  ],
]);
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
});
afterAll(() => {
  for (const [key, descriptor] of rangeGeometry) {
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor);
    else Reflect.deleteProperty(Range.prototype, key);
  }
  if (editableDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "isContentEditable",
      editableDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "isContentEditable");
});
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const usage = {
  eligible: true,
  legacy_drafts_pending: false,
  protections: [],
};

test("portable export captures only the selected source Markdown without editing the draft", async () => {
  vi.mocked(open).mockResolvedValue("C:/sharing");
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "export_markdown_with_files"
      ? {
          format_version: 1,
          status: "complete",
          directory: "C:/sharing/export",
          markdown_path: "content.md",
          manifest_path: "manifest.json",
          attachments: [],
        }
      : command === "attachment_workspace_id"
        ? "workspace-test"
        : [],
  );
  const changed = vi.fn();
  render(
    <MarkdownEditor
      persistentToolbar
      value="Before **selected** after"
      onChange={changed}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  const view = EditorView.findFromDOM(
    screen.getByRole("textbox", { name: "Markdown document source" }),
  )!;
  act(() => view.dispatch({ selection: { anchor: 7, head: 19 } }));
  fireEvent.click(
    screen.getByRole("button", { name: "Export Markdown with files" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("export_markdown_with_files", {
      source: {
        kind: "selection",
        body: "**selected**",
        context: "Before **selected** after",
      },
      output: "C:/sharing",
    }),
  );
  expect(changed).not.toHaveBeenCalled();
});

test("portable export captures a rich selection before Slate's deferred selection update", async () => {
  vi.mocked(open).mockResolvedValue("C:/sharing");
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "export_markdown_with_files"
      ? {
          format_version: 1,
          status: "complete",
          directory: "C:/sharing/export",
          markdown_path: "content.md",
          manifest_path: "manifest.json",
          attachments: [],
        }
      : command === "attachment_workspace_id"
        ? "workspace-test"
        : [],
  );
  const changed = vi.fn();
  render(
    <MarkdownEditor
      persistentToolbar
      value="Before **selected** after"
      onChange={changed}
    />,
  );
  const strong = screen.getByText("selected");
  const range = document.createRange();
  range.selectNodeContents(strong);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.click(
    screen.getByRole("button", { name: "Export Markdown with files" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("export_markdown_with_files", {
      source: { kind: "markdown", body: "**selected**" },
      output: "C:/sharing",
    }),
  );
  expect(changed).not.toHaveBeenCalled();
});

test("native file drops use physical coordinates and ignore other surfaces", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubGlobal("devicePixelRatio", 2);
  let receive: ((event: TauriEvent<DragDropEvent>) => void) | undefined;
  nativeDrop.listen.mockImplementation(async (callback: typeof receive) => {
    receive = callback;
    return () => {};
  });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_upload_destination" ||
    command === "begin_attachment_upload"
      ? { kind: "local" }
      : command === "attachment_workspace_id"
        ? "workspace-test"
        : command === "attachment_upload_limit"
          ? 104857600
          : command === "attachment_uri"
            ? uri
            : file,
  );
  const changed = vi.fn();
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
  const region = screen.getByRole("region", { name: "Markdown document" });
  vi.spyOn(region, "getBoundingClientRect").mockReturnValue({
    left: 10,
    right: 100,
    top: 20,
    bottom: 100,
    x: 10,
    y: 20,
    width: 90,
    height: 80,
    toJSON: () => ({}),
  });
  await waitFor(() => expect(receive).toBeDefined());
  const payload = (x: number): TauriEvent<DragDropEvent> => ({
    event: "tauri://drag-drop",
    id: 1,
    payload: {
      type: "drop",
      paths: ["C:/trace.log"],
      position: new PhysicalPosition(x, 100),
    },
  });
  act(() => receive?.(payload(500)));
  expect(changed).not.toHaveBeenCalled();
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => document.body,
  });
  await act(async () => receive?.(payload(80)));
  expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "Attach file" })).toBeNull();
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => region,
  });
  await act(async () => receive?.(payload(80)));
  await waitFor(() => expect(changed.mock.lastCall?.[0]).toContain(uri));
  expect(invoke).toHaveBeenCalledWith(
    "import_attachment",
    expect.objectContaining({ source: "C:/trace.log" }),
  );
  expect(open).not.toHaveBeenCalled();
  Reflect.deleteProperty(document, "elementFromPoint");
});

test.each(["rich", "source"])(
  "selected Drive files retain their order at the %s caret",
  async (mode) => {
    const native = [
      {
        id: "drive-doc",
        display_name: "Current plan",
        original_filename: "Current plan",
        size_bytes: null,
        kind: "external_reference",
        locator: "drive:connection:doc",
      },
      {
        id: "drive-sheet",
        display_name: "Current sheet",
        original_filename: "Current sheet",
        size_bytes: null,
        kind: "external_reference",
        locator: "drive:connection:sheet",
      },
    ];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "attachment_upload_destination") return { kind: "local" };
      if (command === "begin_attachment_upload")
        return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
      if (command === "attachment_workspace_id")
        return "drive-editor-workspace";
      if (command === "attachment_upload_limit") return 104857600;
      if (command === "drive_configuration")
        return { configured: true, message: "Ready" };
      if (command === "select_drive_files")
        return { files: native, failures: [] };
      if (command === "attachment_uri")
        return `ticketd://attachment/workspace/${String((args as { id: string }).id)}`;
      throw new Error(`Unexpected command ${command}`);
    });
    const changed = vi.fn();
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
    if (mode === "source") {
      fireEvent.click(
        screen.getByRole("button", { name: "Edit Markdown source" }),
      );
      const view = EditorView.findFromDOM(
        screen.getByRole("textbox", { name: "Markdown document source" }),
      )!;
      act(() => view.dispatch({ selection: { anchor: 7 } }));
    } else {
      const text = screen.getByText("Before after").firstChild!;
      const range = document.createRange();
      range.setStart(text, 7);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      fireEvent(document, new Event("selectionchange"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Insert attachment" }));
    fireEvent.click(screen.getByRole("radio", { name: "Google Drive" }));
    const choose = await screen.findByRole("button", {
      name: "Choose in Google Drive",
    });
    await waitFor(() => expect(choose.hasAttribute("disabled")).toBe(false));
    fireEvent.click(choose);
    await screen.findByRole("checkbox", { name: "Current sheet" });
    fireEvent.click(screen.getByRole("button", { name: "Add selected" }));
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith(
        "Before [Current plan](ticketd://attachment/workspace/drive-doc)[Current sheet](ticketd://attachment/workspace/drive-sheet)after",
      ),
    );
  },
);

test.each(["rich", "source"])(
  "batch retry preserves original order at the %s caret",
  async (mode) => {
    vi.mocked(open).mockResolvedValue([
      "C:/first.txt",
      "C:/bad.txt",
      "C:/last.txt",
    ]);
    let fails = true;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "attachment_upload_destination") return { kind: "local" };
      if (command === "begin_attachment_upload")
        return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
      if (command === "attachment_workspace_id") return "workspace-test";
      if (command === "attachment_upload_limit") return 104857600;
      if (command === "attachment_uri")
        return `ticketd://attachment/workspace-1/${String((args as Record<string, unknown>)?.id)}`;
      const name = String((args as Record<string, unknown>)?.source)
        .split("/")
        .at(-1)!;
      if (name === "bad.txt" && fails) throw new Error("Disk full");
      return { ...file, id: name, display_name: name };
    });
    const changed = vi.fn();
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
    if (mode === "source") {
      fireEvent.click(
        screen.getByRole("button", { name: "Edit Markdown source" }),
      );
      const content = screen.getByRole("textbox", {
        name: "Markdown document source",
      });
      const view = EditorView.findFromDOM(content)!;
      act(() => {
        view.dispatch({ selection: { anchor: 7 } });
        view.focus();
      });
    } else {
      const editable = screen.getByRole("textbox", {
        name: "Markdown document rich text",
      });
      editable.focus();
      const range = document.createRange();
      range.setStart(screen.getByText("Before after").firstChild!, 7);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      fireEvent.select(editable);
      fireEvent(document, new Event("selectionchange"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Insert attachment" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    await screen.findByText(/Disk full/);
    await waitFor(() =>
      expect(changed.mock.lastCall?.[0]).toContain("[last.txt]"),
    );
    fails = false;
    const retry = screen.getByRole("button", { name: "Retry" });
    await waitFor(() =>
      expect((retry as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(retry);
    await waitFor(() =>
      expect(changed.mock.lastCall?.[0]).toBe(
        "Before [first.txt](ticketd://attachment/workspace-1/first.txt)[bad.txt](ticketd://attachment/workspace-1/bad.txt)[last.txt](ticketd://attachment/workspace-1/last.txt)after",
      ),
    );
  },
);

test.each(["paste", "drop"])(
  "%s captures file bytes in the shared source editor without native paths or premature links",
  async (kind) => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "attachment_upload_destination" ||
      command === "begin_attachment_upload"
        ? { kind: "local" }
        : command === "attachment_workspace_id"
          ? "workspace-test"
          : command === "attachment_upload_limit"
            ? 104857600
            : command === "attachment_uri"
              ? uri
              : file,
    );
    const changed = vi.fn();
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
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Markdown source" }),
    );
    const content = screen.getByRole("textbox", {
      name: "Markdown document source",
    });
    const view = EditorView.findFromDOM(content)!;
    act(() => {
      view.dispatch({ selection: { anchor: 7 } });
    });
    const screenshot = new File(
      [new Uint8Array([137, 80, 78, 71])],
      "screenshot.png",
      { type: "image/png" },
    );
    Object.defineProperty(screenshot, "arrayBuffer", {
      value: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    });
    if (kind === "paste")
      fireEvent.paste(content, {
        clipboardData: {
          items: [
            { kind: "file", type: "image/png", getAsFile: () => screenshot },
          ],
          getData: () => "",
        },
      });
    else
      fireEvent.drop(content, {
        dataTransfer: { files: [screenshot], types: ["Files"] },
      });
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith(
        `Before [trace [final].log](${uri})after`,
      ),
    );
    expect(invoke).toHaveBeenCalledWith(
      "capture_attachment",
      new Uint8Array([137, 80, 78, 71]),
      expect.objectContaining({
        headers: {
          "x-ticketd-upload": expect.stringContaining(
            '"filename":"screenshot.png"',
          ),
        },
      }),
    );
    expect(open).not.toHaveBeenCalled();
  },
);
const file = {
  id: "file-1",
  display_name: "trace [final].log",
  original_filename: "trace.log",
  size_bytes: 12,
  kind: "local_snapshot",
  locator: "file-1/bytes/trace.log",
};
const uri = "ticketd://attachment/workspace-1/file-1";

test("rich attachment inspection and close leave the unsent editor draft untouched", async () => {
  const changed = vi.fn();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace-1";
    if (command === "resolve_attachment_uri") return file;
    if (command === "attachment_preview")
      return {
        attachment: file,
        status: "unsupported",
        media_type: null,
        message: "Preview unavailable for this format.",
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    return null;
  });
  render(
    <MarkdownEditor
      value={`Before [Authored label](${uri}) after`}
      onChange={changed}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Preview attachment: Authored label" }),
  );
  await screen.findByRole("heading", { name: "trace [final].log" });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(changed).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith("open_attachment", expect.anything());
});

test("inserts a stored file at the rich caret without rewriting on focus or mode changes", async () => {
  const changed = vi.fn();
  vi.mocked(open).mockResolvedValue("C:/trace.log");
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_upload_destination" ||
    command === "begin_attachment_upload"
      ? { kind: "local" }
      : command === "attachment_workspace_id"
        ? "workspace-test"
        : command === "attachment_upload_limit"
          ? 104857600
          : command === "attachment_uri"
            ? uri
            : file,
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
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      `Before [trace [final].log](${uri})after`,
    ),
  );
  const saved = changed.mock.lastCall?.[0];
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Attach file" })).toBeNull(),
  );
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

test.each([
  ["rich", "[Open issue](https://example.test/issues/1)", "issue"],
  ["source", "[Open issue](https://example.test/issues/1)", "issue"],
  ["source", "![Open issue](https://example.test/image.png)", "issue"],
  ["source", "<https://example.test/issues/1>", "example"],
])(
  "inserting an attachment from inside %s %s preserves the existing link",
  async (mode, markup, caretText) => {
    const original = `Before ${markup} after`;
    const changed = vi.fn();
    vi.mocked(open).mockResolvedValue("C:/trace.log");
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "attachment_upload_destination" ||
      command === "begin_attachment_upload"
        ? { kind: "local" }
        : command === "attachment_workspace_id"
          ? "workspace-test"
          : command === "attachment_upload_limit"
            ? 104857600
            : command === "attachment_uri"
              ? uri
              : file,
    );
    function Draft() {
      const [value, setValue] = useState(original);
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

    if (mode === "source") {
      const toggle = screen.queryByRole("button", {
        name: "Edit Markdown source",
      });
      if (toggle) fireEvent.click(toggle);
      const source = screen.getByRole("textbox", {
        name: "Markdown document source",
      });
      EditorView.findFromDOM(source)?.dispatch({
        selection: { anchor: original.indexOf(caretText) },
      });
    } else {
      const editable = screen.getByRole("textbox", {
        name: "Markdown document rich text",
      });
      Object.defineProperty(editable, "isContentEditable", { value: true });
      editable.focus();
      const text = screen.getByText("Open issue").firstChild!;
      const range = document.createRange();
      range.setStart(text, 5);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      fireEvent.select(editable);
      fireEvent(document, new Event("selectionchange"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    }

    fireEvent.click(screen.getByRole("button", { name: "Insert attachment" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith(
        `Before ${markup}[trace [final].log](${uri}) after`,
      ),
    );
  },
);

test("a failed upload cannot insert a valid link and retry keeps the upload identity", async () => {
  const changed = vi.fn();
  vi.mocked(open).mockResolvedValue("C:/trace.log");
  let failed = true;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace-test";
    if (command === "attachment_upload_limit") return 104857600;
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
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
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
      .map(([, args]) => (args as Record<string, unknown>)?.requestId),
  ).toEqual([
    (original as Record<string, unknown>)?.requestId,
    (original as Record<string, unknown>)?.requestId,
  ]);
});

test("source insertion reuses a stored identity while preserving image syntax and unsupported content", async () => {
  const original = `![literal image label](${uri})\n\n<!-- preserve this source -->`;
  const changed = vi.fn();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_upload_destination" ||
    command === "begin_attachment_upload"
      ? { kind: "local" }
      : command === "attachment_workspace_id"
        ? "workspace-test"
        : command === "attachment_upload_limit"
          ? 104857600
          : command === "attachment_uri"
            ? uri
            : command === "search_attachments"
              ? [{ attachment: file, related: false, usage }]
              : file,
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
  // A pasted ticketd link finds its file.
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search existing files" }),
    { target: { value: `<ticketd://attachment/workspace-test/${file.id}>` } },
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("search_attachments", {
      query: expect.objectContaining({ search: file.id }),
    }),
  );
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Select / }));
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
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

test("source insertion inside a table escapes filename pipes without adding a column", async () => {
  const original = "| File |\n| --- |\n| before after |";
  const changed = vi.fn();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_upload_destination" ||
    command === "begin_attachment_upload"
      ? { kind: "local" }
      : command === "attachment_workspace_id"
        ? "workspace-test"
        : command === "attachment_uri"
          ? uri
          : command === "search_attachments"
            ? [
                {
                  attachment: { ...file, display_name: "trace | final" },
                  related: false,
                  usage,
                },
              ]
            : { ...file, display_name: "trace | final" },
  );
  function Draft() {
    const [value, setValue] = useState(original);
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
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  const source = screen.getByRole("textbox", {
    name: "Markdown document source",
  });
  // Set the external editor widget's selection; jsdom has no native caret navigation.
  EditorView.findFromDOM(source)?.dispatch({
    selection: { anchor: original.indexOf("after") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Insert attachment" }));
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  // A pasted ticketd link finds its file.
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search existing files" }),
    { target: { value: `<ticketd://attachment/workspace-test/${file.id}>` } },
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("search_attachments", {
      query: expect.objectContaining({ search: file.id }),
    }),
  );
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Select / }));
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  await waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      `| File |\n| --- |\n| before [trace \\| final](${uri})after |`,
    ),
  );
});

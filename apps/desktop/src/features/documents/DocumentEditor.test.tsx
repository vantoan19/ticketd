// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor";
import { documents } from "./api";
vi.mock("./api", () => ({
  documents: {
    save: vi.fn(),
    show: vi.fn(),
    setTrashed: vi.fn(),
    links: vi.fn().mockResolvedValue([[], []]),
    createTicket: vi.fn(),
    linkMarkdown: vi.fn(),
  },
}));
vi.mock("@/features/markdown/LazyMarkdownEditor", () => ({
  LazyMarkdownEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Your thought"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
beforeEach(() => {
  vi.mocked(documents.links).mockResolvedValue([[], []]);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.resetAllMocks();
});
it("returns without creating an untouched capture", async () => {
  const close = vi.fn();
  render(<DocumentEditor initial={null} onClose={close} />);
  fireEvent.click(screen.getByText("Back to work"));
  expect(close).toHaveBeenCalledOnce();
  expect(documents.save).not.toHaveBeenCalled();
});
it("keeps a failed capture open and retries the same request before returning", async () => {
  vi.mocked(documents.save)
    .mockRejectedValueOnce("disk full")
    .mockResolvedValueOnce({
      id: "d1",
      title: null,
      body: "A thought",
      created_at: "now",
      updated_at: "now",
      trashed: false,
    });
  const close = vi.fn();
  render(<DocumentEditor initial={null} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "A thought" },
  });
  fireEvent.click(screen.getByText("Back to work"));
  await screen.findByText(/Could not save/);
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Retry"));
  await waitFor(() => expect(documents.save).toHaveBeenCalledTimes(2));
  expect(vi.mocked(documents.save).mock.calls[0]).toEqual(
    vi.mocked(documents.save).mock.calls[1],
  );
  await screen.findByText("Saved locally");
  fireEvent.click(screen.getByText("Back to work"));
  expect(close).toHaveBeenCalledOnce();
});
it("notices saved changes beneath a focused draft and offers reload", async () => {
  vi.useFakeTimers();
  const original = {
    id: "d1",
    title: null,
    body: "Original",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  vi.mocked(documents.save).mockRejectedValue("offline");
  vi.mocked(documents.show).mockResolvedValue({
    ...original,
    body: "Changed externally",
  });
  render(<DocumentEditor initial={original} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Write" }));
  const editor = screen.getByLabelText("Your thought");
  editor.focus();
  fireEvent.change(editor, { target: { value: "Local draft" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(documents.show).toHaveBeenCalled();
  expect(editor).toHaveProperty("value", "Local draft");
  expect(document.activeElement).toBe(editor);
  expect(screen.getByText(/Saved content changed/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reload saved content" }));
  expect(editor).toHaveProperty("value", "Changed externally");
});
it("preserves an unrelated saved title when saving over a conflicting body", async () => {
  vi.useFakeTimers();
  const original = {
    id: "d1",
    title: "Original title",
    body: "Original",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  vi.mocked(documents.save)
    .mockRejectedValueOnce("offline")
    .mockResolvedValueOnce({
      ...original,
      title: "External title",
      body: "Draft",
    });
  vi.mocked(documents.show).mockResolvedValue({
    ...original,
    title: "External title",
    body: "External body",
  });
  render(<DocumentEditor initial={original} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Write" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Draft" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save over saved content" }),
  );
  await act(async () => {});
  expect(vi.mocked(documents.save).mock.calls[1]?.slice(1, 4)).toEqual([
    "External title",
    "Draft",
    false,
  ]);
});
it("suggests only the current ticket and lets it be removed before capture", async () => {
  vi.mocked(documents.save).mockResolvedValue({
    id: "d1",
    title: null,
    body: "Thought",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  });
  render(
    <DocumentEditor initial={null} onClose={vi.fn()} currentTicket="T-12" />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Remove connection to T-12" }),
  );
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Thought" },
  });
  fireEvent.click(screen.getByText("Back to work"));
  await waitFor(() => expect(documents.save).toHaveBeenCalled());
  expect(vi.mocked(documents.save).mock.calls[0]?.[2]).toBe("Thought");
});
it("inserts a validated link into the draft", async () => {
  vi.mocked(documents.linkMarkdown).mockResolvedValue(
    "[T-4](ticketd://ticket/T-4)",
  );
  render(<DocumentEditor initial={null} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Link target"), {
    target: { value: "T-4" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Insert link" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Your thought") as HTMLTextAreaElement).value,
    ).toBe("[T-4](ticketd://ticket/T-4)"),
  );
});
it("opens a connected ticket after saving a document draft", async () => {
  const document = {
    id: "d1",
    title: null,
    body: "Original",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  vi.mocked(documents.links).mockResolvedValue([
    [],
    [
      {
        source_id: "t1",
        target_id: "d1",
        source_kind: "ticket",
        target_kind: "document",
        source_label: "T-4",
        target_label: "Document",
        source_trashed: false,
        target_trashed: false,
        passage: "Source",
      },
    ],
  ]);
  vi.mocked(documents.save).mockResolvedValue({ ...document, body: "Updated" });
  const open = vi.fn();
  render(
    <DocumentEditor initial={document} onClose={vi.fn()} onOpenTicket={open} />,
  );
  await screen.findByText("Source");
  fireEvent.click(screen.getByRole("button", { name: "Write" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Updated" },
  });
  fireEvent.click(screen.getByRole("button", { name: "T-4" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("T-4"));
  expect(vi.mocked(documents.save).mock.calls[0]?.[2]).toBe("Updated");
});

it("opens a trashed Document readably and restores it", async () => {
  const original = {
    id: "d1",
    title: "Context",
    body: "Preserved",
    created_at: "now",
    updated_at: "now",
    trashed: true,
  };
  vi.mocked(documents.setTrashed).mockResolvedValue({
    ...original,
    trashed: false,
  });
  render(<DocumentEditor initial={original} onClose={vi.fn()} />);
  expect(screen.getByText("This Document is in Trash.")).toBeTruthy();
  expect(screen.getByText("Preserved")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Write" }));
  expect(screen.getByLabelText("Optional title")).toHaveProperty(
    "readOnly",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByRole("button", { name: "Move to Trash" });
  expect(documents.setTrashed).toHaveBeenCalledWith(
    "d1",
    false,
    expect.any(String),
  );
  expect(screen.getByLabelText("Your thought")).toHaveProperty(
    "value",
    "Preserved",
  );
});
it("keeps capture typing unchanged while saving the suggested connection", async () => {
  vi.mocked(documents.save).mockResolvedValue({
    id: "d1",
    title: null,
    body: "Thought\n\n[T-12](ticketd://ticket/T-12)",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  });
  render(
    <DocumentEditor initial={null} onClose={vi.fn()} currentTicket="T-12" />,
  );
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Thought" },
  });
  fireEvent.click(screen.getByText("Back to work"));
  await waitFor(() => expect(documents.save).toHaveBeenCalled());
  expect(vi.mocked(documents.save).mock.calls[0]?.[2]).toBe(
    "Thought\n\n[T-12](ticketd://ticket/T-12)",
  );
  expect(
    (screen.getByLabelText("Your thought") as HTMLTextAreaElement).value,
  ).toBe("Thought");
});
it("removes a suggested connection after the first save", async () => {
  vi.mocked(documents.save).mockResolvedValue({
    id: "d1",
    title: null,
    body: "Thought",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  });
  render(
    <DocumentEditor initial={null} onClose={vi.fn()} currentTicket="T-12" />,
  );
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Thought" },
  });
  await waitFor(() => expect(documents.save).toHaveBeenCalledTimes(1));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove connection to T-12" }),
  );
  await waitFor(() => expect(documents.save).toHaveBeenCalledTimes(2));
  expect(vi.mocked(documents.save).mock.calls[1]?.[2]).toBe("Thought");
});

it("saves a draft before opening the context graph without a dialog", async () => {
  const doc = {
    id: "d1",
    title: "Context",
    body: "Original",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  vi.mocked(documents.save).mockResolvedValue({ ...doc, body: "Draft" });
  const graph = vi.fn();
  render(
    <DocumentEditor initial={doc} onClose={vi.fn()} onOpenGraph={graph} />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Original")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Write" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Context graph" }));
  await waitFor(() => expect(graph).toHaveBeenCalledWith("d1"));
  expect(vi.mocked(documents.save).mock.calls[0]?.[2]).toBe("Draft");
});

it("opens the originating ticket from document details", () => {
  const doc = {
    id: "d1",
    title: null,
    body: "Evidence",
    origin_brief: "Update",
    origin_ticket: "T-3",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  const open = vi.fn();
  render(
    <DocumentEditor initial={doc} onClose={vi.fn()} onOpenTicket={open} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "T-3 · Activity details" }),
  );
  expect(open).toHaveBeenCalledWith("T-3");
});

it("reads an untitled Document with its core heading and current save details", async () => {
  const doc = {
    id: "d1",
    title: null,
    heading: "First line",
    body: "First line\nMore",
    created_at: "created",
    updated_at: "before",
    trashed: false,
  };
  vi.mocked(documents.save).mockResolvedValue({
    ...doc,
    body: "Changed",
    heading: "Changed",
    updated_at: "after",
  });
  render(<DocumentEditor initial={doc} onClose={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "First line" })).toBeTruthy();
  expect(screen.getByText("before")).toBeTruthy();
  expect(screen.getAllByText("Saved locally")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Write" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Changed" },
  });
  await waitFor(() => expect(screen.getByText("after")).toBeTruthy());
  expect(screen.getByRole("heading", { name: "Changed" })).toBeTruthy();
});

it("consumes graph navigation after saving so later edits stay on the Document", async () => {
  vi.useFakeTimers();
  const doc = {
    id: "d1",
    title: "Context",
    body: "Original",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  vi.mocked(documents.save).mockImplementation(async (_id, _title, body) => ({
    ...doc,
    body: body ?? doc.body,
  }));
  const graph = vi.fn();
  render(
    <DocumentEditor initial={doc} onClose={vi.fn()} onOpenGraph={graph} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Write" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "First" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Context graph" }));
  await act(async () => {});
  expect(graph).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Second" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(graph).toHaveBeenCalledTimes(1);
});

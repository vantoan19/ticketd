// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor";
import { documents } from "./api";
import { TickingChanges } from "@/test/ticking-changes";
import { syncReview } from "@/lib/sync-review-api";

vi.mock("@/lib/sync-review-api", () => ({
  syncReview: {
    conflicts: vi.fn(async () => []),
    versions: vi.fn(async () => []),
  },
}));
const renderEditor = (ui: ReactElement) =>
  render(<TickingChanges>{ui}</TickingChanges>);
vi.mock("./api", () => ({
  documents: {
    save: vi.fn(),
    show: vi.fn(),
    version: vi.fn(),
    setTrashed: vi.fn(),
    links: vi.fn().mockResolvedValue([[], []]),
    createTicket: vi.fn(),
    linkMarkdown: vi.fn(),
    recent: vi.fn(),
    search: vi.fn(),
  },
}));
vi.mock("@/features/markdown/LazyMarkdownEditor", () => ({
  LazyMarkdownEditor: ({
    value,
    onChange,
    focusRequest = 0,
  }: {
    value: string;
    onChange: (value: string) => void;
    focusRequest?: number;
  }) => (
    <textarea
      aria-label="Your thought"
      data-focus-request={focusRequest}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
/** The stored Document differs from what the editor last saw. */
const outside = (document: Awaited<ReturnType<typeof documents.show>>) => {
  vi.mocked(documents.show).mockResolvedValue(document);
  vi.mocked(documents.version).mockResolvedValue(["outside", document.trashed]);
};
beforeEach(() => {
  vi.mocked(documents.links).mockResolvedValue([[], []]);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.resetAllMocks();
});
it("disables Done with a stated reason until a thought is written", async () => {
  const close = vi.fn();
  renderEditor(<DocumentEditor initial={null} onClose={close} />);
  const done = screen.getByRole("button", { name: "Done" });
  expect((done as HTMLButtonElement).disabled).toBe(true);
  expect(done.getAttribute("aria-describedby")).toBeTruthy();
  expect(screen.getByText("Write a thought to finish")).toBeTruthy();
  fireEvent.click(done);
  expect(close).not.toHaveBeenCalled();
  expect(documents.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "A thought" },
  });
  expect(
    (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it("tells a capture it is saved to Documents once it has text", async () => {
  vi.mocked(documents.save).mockResolvedValue({
    id: "d1",
    title: null,
    body: "A thought",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  });
  renderEditor(<DocumentEditor initial={null} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "A thought" },
  });
  const status = await screen.findByText("Saved to Documents as you type");
  expect(status.querySelector("svg")).toBeTruthy();
  expect(screen.queryByText("Saved on this computer")).toBeNull();
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
  renderEditor(<DocumentEditor initial={null} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "A thought" },
  });
  fireEvent.click(screen.getByText("Done"));
  await screen.findByText(/couldn’t save your changes/);
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Retry"));
  await waitFor(() => expect(documents.save).toHaveBeenCalledTimes(2));
  expect(vi.mocked(documents.save).mock.calls[0]).toEqual(
    vi.mocked(documents.save).mock.calls[1],
  );
  await screen.findByText("Saved to Documents as you type");
  fireEvent.click(screen.getByText("Done"));
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
  outside({
    ...original,
    body: "Changed externally",
  });
  renderEditor(<DocumentEditor initial={original} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
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
  outside({
    ...original,
    title: "External title",
    body: "External body",
  });
  renderEditor(<DocumentEditor initial={original} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Draft" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save my draft" }));
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
  renderEditor(
    <DocumentEditor initial={null} onClose={vi.fn()} currentTicket="T-KQ12" />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Remove connection to T-KQ12" }),
  );
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Thought" },
  });
  fireEvent.click(screen.getByText("Done"));
  await waitFor(() => expect(documents.save).toHaveBeenCalled());
  expect(vi.mocked(documents.save).mock.calls[0]?.[2]).toBe("Thought");
});
it("inserts a link to a Document chosen by title into the draft", async () => {
  vi.mocked(documents.recent).mockResolvedValue([
    { id: "d9", heading: "Release plan" } as never,
  ]);
  renderEditor(
    <DocumentEditor
      initial={{
        id: "d1",
        title: "Doc",
        body: "",
        created_at: "now",
        updated_at: "now",
        trashed: false,
      }}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Link a Document" }));
  fireEvent.click(await screen.findByRole("button", { name: "Release plan" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Your thought") as HTMLTextAreaElement).value,
    ).toBe("[Release plan](ticketd://document/d9)"),
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
        source_label: "T-KQ4",
        target_label: "Document",
        source_trashed: false,
        target_trashed: false,
        passage: "Source",
      },
    ],
  ]);
  vi.mocked(documents.save).mockResolvedValue({ ...document, body: "Updated" });
  const open = vi.fn();
  renderEditor(
    <DocumentEditor initial={document} onClose={vi.fn()} onOpenTicket={open} />,
  );
  await screen.findByText(/^From\s*“/);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Updated" },
  });
  fireEvent.click(screen.getByRole("button", { name: "T-KQ4" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("T-KQ4"));
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
  renderEditor(<DocumentEditor initial={original} onClose={vi.fn()} />);
  // The Trash banner is a status the reader is told about.
  expect(
    screen
      .getAllByRole("status")
      .some((s) => s.textContent?.includes("In Trash")),
  ).toBe(true);
  expect(screen.getByText("Preserved")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  expect(screen.getByLabelText("Title")).toHaveProperty("readOnly", true);
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByRole("button", { name: "Document actions" });
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
    body: "Thought\n\n[T-KQ12](ticketd://ticket/T-KQ12)",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  });
  renderEditor(
    <DocumentEditor initial={null} onClose={vi.fn()} currentTicket="T-KQ12" />,
  );
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Thought" },
  });
  fireEvent.click(screen.getByText("Done"));
  await waitFor(() => expect(documents.save).toHaveBeenCalled());
  expect(vi.mocked(documents.save).mock.calls[0]?.[2]).toBe(
    "Thought\n\n[T-KQ12](ticketd://ticket/T-KQ12)",
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
  renderEditor(
    <DocumentEditor initial={null} onClose={vi.fn()} currentTicket="T-KQ12" />,
  );
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Thought" },
  });
  await waitFor(() => expect(documents.save).toHaveBeenCalledTimes(1));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove connection to T-KQ12" }),
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
  renderEditor(
    <DocumentEditor initial={doc} onClose={vi.fn()} onOpenGraph={graph} />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Original")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open context graph" }));
  await waitFor(() => expect(graph).toHaveBeenCalledWith("d1"));
  expect(vi.mocked(documents.save).mock.calls[0]?.[2]).toBe("Draft");
});

it("opens the originating ticket from document details", () => {
  const doc = {
    id: "d1",
    title: null,
    body: "Evidence",
    origin_brief: "Update",
    origin_ticket: "T-KQ3",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  const open = vi.fn();
  renderEditor(
    <DocumentEditor initial={doc} onClose={vi.fn()} onOpenTicket={open} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "T-KQ3 · Update details" }),
  );
  expect(open).toHaveBeenCalledWith("T-KQ3");
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
  renderEditor(<DocumentEditor initial={doc} onClose={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "First line" })).toBeTruthy();
  expect(screen.getAllByText(/before/).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Saved on this computer")).toHaveLength(1);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Changed" },
  });
  await waitFor(() =>
    expect(screen.getAllByText(/after/).length).toBeGreaterThan(0),
  );
  expect(document.querySelector(".document-crumb-title")?.textContent).toBe(
    "Changed",
  );
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
  renderEditor(
    <DocumentEditor initial={doc} onClose={vi.fn()} onOpenGraph={graph} />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "First" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open context graph" }));
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

it("preserves successive unrelated saved title changes under a body conflict", async () => {
  vi.useFakeTimers();
  const doc = {
    id: "d1",
    title: "Original",
    body: "Original body",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  vi.mocked(documents.save)
    .mockRejectedValueOnce("offline")
    .mockResolvedValueOnce({
      ...doc,
      title: "External 2",
      body: "Local draft",
    });
  let polls = 0;
  vi.mocked(documents.version).mockImplementation(async () => [
    `poll-${++polls}`,
    false,
  ]);
  vi.mocked(documents.show)
    .mockResolvedValueOnce({
      ...doc,
      title: "External 1",
      body: "External body",
    })
    .mockResolvedValue({ ...doc, title: "External 2", body: "External body" });
  renderEditor(<DocumentEditor initial={doc} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Local draft" },
  });
  // One poll per act: batched ticks inside a single act would be one change.
  for (let poll = 0; poll < 2; poll++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
  fireEvent.click(screen.getByRole("button", { name: "Save my draft" }));
  await act(async () => {});
  expect(vi.mocked(documents.save).mock.calls[1]?.slice(1, 4)).toEqual([
    "External 2",
    "Local draft",
    false,
  ]);
});

it("shows readable linked context and opens a Document referenced in its passage", async () => {
  vi.mocked(documents.links).mockResolvedValue([
    [],
    [
      {
        source_id: "source",
        target_id: "d1",
        source_kind: "document",
        target_kind: "document",
        source_label: "Source",
        target_label: "Current",
        source_trashed: false,
        target_trashed: false,
        passage: "See [related context](ticketd://document/related-id).",
      },
    ],
  ]);
  const open = vi.fn();
  renderEditor(
    <DocumentEditor
      initial={{
        id: "d1",
        title: "Current",
        body: "Body",
        created_at: "2026-11-04T00:00:00Z",
        updated_at: "2026-11-04T00:00:00Z",
        trashed: false,
      }}
      onClose={vi.fn()}
      onOpenDocument={open}
    />,
  );
  const link = await screen.findByRole("button", { name: "related context" });
  expect(screen.queryByText(/ticketd:\/\/document/)).toBeNull();
  fireEvent.click(link);
  expect(open).toHaveBeenCalledWith("related-id");
  expect(
    screen.queryByRole("textbox", { name: "New ticket title" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Create ticket from this" }),
  );
  expect(screen.getByLabelText("New ticket title")).toBeTruthy();
});

it("lists each connected item once and names Plans that use the Document as spec", async () => {
  const document = {
    id: "d1",
    title: "Spec",
    body: "x",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  const link = (source: string, target: string) => ({
    source_id: source,
    target_id: target,
    source_kind: source === "d1" ? "document" : "ticket",
    target_kind: target === "d1" ? "document" : "ticket",
    source_label: source === "d1" ? "Spec" : "T-KQ4",
    target_label: target === "d1" ? "Spec" : "T-KQ4",
    source_trashed: false,
    target_trashed: false,
    passage: "mention",
  });
  vi.mocked(documents.links).mockResolvedValue([
    [link("d1", "t4")],
    [
      link("t4", "d1"),
      {
        ...link("p1", "d1"),
        source_kind: "plan",
        source_label: "Roadmap",
        passage: "",
      },
    ],
  ]);
  renderEditor(<DocumentEditor initial={document} onClose={vi.fn()} />);
  await screen.findByRole("button", { name: /T-KQ4/ });
  expect(screen.getAllByRole("button", { name: /T-KQ4/ })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Roadmap" })).toBeTruthy();
  expect(
    screen.getByText(/^Updated .* · spec of the Plan Roadmap$/),
  ).toBeTruthy();
});

it("names a Plan that only has the Document attached as a supporting Document", async () => {
  const document = {
    id: "d1",
    title: "Checkout spec",
    body: "x",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  vi.mocked(documents.links).mockResolvedValue([
    [],
    [
      {
        source_id: "p1",
        target_id: "d1",
        source_kind: "plan",
        target_kind: "document",
        source_label: "Checkout revamp",
        target_label: "",
        source_trashed: false,
        target_trashed: false,
        passage: "",
        explicit: true,
      },
    ],
  ]);
  renderEditor(<DocumentEditor initial={document} onClose={vi.fn()} />);
  expect(
    await screen.findByRole("button", {
      name: "Checkout revamp",
    }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      /^Updated .* · supporting Document of the Plan Checkout revamp$/,
    ),
  ).toBeTruthy();
});

it("Edit shows the heading once: the title field holds it and the editor keeps the saved text", async () => {
  const doc = {
    id: "d1",
    title: null,
    heading: "Checkout spec",
    body: "# Checkout spec\n\nSee the flow.",
    created_at: "c",
    updated_at: "u",
    trashed: false,
  };
  renderEditor(<DocumentEditor initial={doc} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Checkout spec",
  );
  const editor = screen.getByLabelText("Your thought") as HTMLTextAreaElement;
  expect(editor.value).toBe("See the flow.");
  vi.mocked(documents.save).mockResolvedValue({
    ...doc,
    body: "# Checkout spec\n\nSee the new flow.",
  });
  fireEvent.change(editor, { target: { value: "See the new flow." } });
  await waitFor(() =>
    expect(vi.mocked(documents.save).mock.calls[0]?.[2]).toBe(
      "# Checkout spec\n\nSee the new flow.",
    ),
  );
});

const base = { id: "d1", created_at: "c", updated_at: "u", trashed: false };

it("shows the title once in Read: a body heading that repeats it is not rendered again", () => {
  const doc = {
    ...base,
    title: "Checkout spec",
    body: "# Checkout spec\n\nSee the flow.",
  };
  renderEditor(<DocumentEditor initial={doc} onClose={vi.fn()} />);
  expect(
    screen.getAllByRole("heading", { name: "Checkout spec", level: 1 }),
  ).toHaveLength(1);
  expect(screen.getByText("See the flow.")).toBeTruthy();
});

it("keeps a body heading that differs from the explicit title", () => {
  const doc = { ...base, title: "Checkout spec", body: "# Overview\n\nText" };
  renderEditor(<DocumentEditor initial={doc} onClose={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
});

it("edits the title in place without repeating the heading as a placeholder", () => {
  const doc = {
    ...base,
    title: null,
    heading: "First line",
    body: "First line\nMore",
  };
  renderEditor(<DocumentEditor initial={doc} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  const title = screen.getByRole("textbox", { name: "Title" });
  expect(title.getAttribute("placeholder")).toBe("Title");
  expect(screen.queryByText("Optional title")).toBeNull();
});
const stored = {
  id: "d1",
  title: null,
  body: "Original",
  created_at: "now",
  updated_at: "now",
  trashed: false,
};
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
it("clears the conflict notice once the outside change is undone", async () => {
  vi.useFakeTimers();
  vi.mocked(documents.save).mockRejectedValueOnce("offline");
  vi.mocked(documents.save).mockResolvedValue({ ...stored, body: "Typed" });
  outside({ ...stored, body: "Outside" });
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Typed" },
  });
  await tick(2400);
  expect(screen.getByText(/Saved content changed/)).toBeTruthy();
  vi.mocked(documents.version).mockResolvedValue(["undone", false]);
  vi.mocked(documents.show).mockResolvedValue(stored);
  await tick(2000);
  expect(screen.queryByText(/Saved content changed/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Typed again" },
  });
  await tick(400);
  expect(vi.mocked(documents.save).mock.calls.length).toBeGreaterThan(1);
});
it("refreshes silently when an outside change arrives and nothing is unsaved", async () => {
  vi.useFakeTimers();
  outside({ ...stored, body: "Outside" });
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  const editor = screen.getByLabelText("Your thought");
  editor.focus();
  await tick(2000);
  expect(screen.queryByText(/Saved content changed/)).toBeNull();
  expect(editor).toHaveProperty("value", "Outside");
});
it("sends the loaded revision and keeps the draft when the save is stale", async () => {
  vi.useFakeTimers();
  vi.mocked(documents.save).mockRejectedValueOnce(
    "document 'd1' was changed elsewhere since it was loaded",
  );
  outside({ ...stored, body: "Via CLI", updated_at: "later" });
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Typed" },
  });
  await tick(400);
  expect(vi.mocked(documents.save).mock.calls[0]?.[4]).toBe("now");
  expect(screen.getByText(/Saved content changed/)).toBeTruthy();
  expect(screen.getByLabelText("Your thought")).toHaveProperty(
    "value",
    "Typed",
  );
  vi.mocked(documents.save).mockResolvedValue({ ...stored, body: "Typed" });
  fireEvent.click(screen.getByRole("button", { name: "Save my draft" }));
  await tick(0);
  expect(vi.mocked(documents.save).mock.calls[1]?.[4]).toBe("later");
});
it("drops a failed Trash request instead of replaying it on the next autosave", async () => {
  vi.useFakeTimers();
  vi.mocked(documents.setTrashed).mockRejectedValue("busy");
  vi.mocked(documents.save).mockResolvedValue({ ...stored, body: "More" });
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Document actions" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
  await tick(0);
  expect(documents.setTrashed).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "More" },
  });
  await tick(400);
  expect(documents.save).toHaveBeenCalledOnce();
  expect(documents.setTrashed).toHaveBeenCalledOnce();
});
it("ignores Back to work under the conflict notice instead of replaying it", async () => {
  vi.useFakeTimers();
  const close = vi.fn();
  vi.mocked(documents.save).mockRejectedValue("offline");
  outside({ ...stored, body: "Outside" });
  renderEditor(<DocumentEditor initial={stored} onClose={close} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Draft" },
  });
  await tick(2400);
  fireEvent.click(screen.getByRole("button", { name: "Back to work" }));
  fireEvent.click(screen.getByRole("button", { name: "Reload saved content" }));
  await tick(1000);
  expect(close).not.toHaveBeenCalled();
});
it("restores a Document trashed elsewhere without resending the unsaved draft", async () => {
  vi.useFakeTimers();
  vi.mocked(documents.save).mockRejectedValue("document is in Trash");
  outside({ ...stored, trashed: true });
  vi.mocked(documents.setTrashed).mockResolvedValue({
    ...stored,
    trashed: false,
  });
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Draft" },
  });
  await tick(400);
  expect(documents.save).toHaveBeenCalledOnce();
  await tick(2000);
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await tick(0);
  expect(documents.setTrashed).toHaveBeenCalledOnce();
});
it("does not report a conflict after saving a whitespace-only title", async () => {
  vi.useFakeTimers();
  const titled = { ...stored, title: "Doc" };
  vi.mocked(documents.save).mockResolvedValue({ ...stored, title: null });
  outside({ ...stored, title: null });
  renderEditor(<DocumentEditor initial={titled} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  screen.getByLabelText("Title").focus();
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "   " },
  });
  await tick(400);
  expect(vi.mocked(documents.save).mock.calls[0]?.[1]).toBeNull();
  await tick(2000);
  expect(screen.queryByText(/Saved content changed/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "New" },
  });
  await tick(400);
  expect(documents.save).toHaveBeenCalledTimes(2);
});
it("shows a derived heading once in the reader", () => {
  renderEditor(
    <DocumentEditor
      initial={{
        ...stored,
        heading: "Meeting notes",
        body: "# Meeting notes\n\nAgenda",
      }}
      onClose={vi.fn()}
    />,
  );
  expect(
    screen.getAllByRole("heading", { name: "Meeting notes" }),
  ).toHaveLength(1);
  expect(screen.getByText("Agenda")).toBeTruthy();
});
it("says nothing is saved and explains a blocked Back to work while the conflict notice is up", async () => {
  vi.useFakeTimers();
  const close = vi.fn();
  vi.mocked(documents.save).mockRejectedValueOnce("offline");
  outside({ ...stored, body: "Outside" });
  renderEditor(<DocumentEditor initial={stored} onClose={close} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "Typed" },
  });
  await tick(2400);
  expect(screen.getByRole("status").textContent).toContain(
    "Not saved — changed elsewhere",
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to work" }));
  expect(close).not.toHaveBeenCalled();
  const notice = document.querySelector<HTMLElement>(".document-conflict")!;
  expect(document.activeElement).toBe(notice);
  expect(notice.textContent).toContain("Choose Reload or Save my draft first");
});
it("keeps Done in place through the pointer sequence that blurs the editor", async () => {
  vi.mocked(documents.save).mockResolvedValue({
    id: "d1",
    title: null,
    body: "A thought",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  });
  const close = vi.fn();
  renderEditor(<DocumentEditor initial={null} onClose={close} />);
  const editor = screen.getByLabelText("Your thought");
  fireEvent.change(editor, { target: { value: "A thought" } });
  const done = screen.getByRole("button", { name: "Done" });
  editor.focus();
  fireEvent.pointerDown(done);
  fireEvent.mouseDown(done);
  editor.blur();
  expect(screen.getByRole("button", { name: "Done" })).toBe(done);
  fireEvent.pointerUp(done);
  fireEvent.mouseUp(done);
  fireEvent.click(done);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("asks the editor to take focus back after each conflict action (D2)", async () => {
  vi.useFakeTimers();
  const original = {
    id: "d1",
    title: "T",
    body: "Original",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  vi.mocked(documents.save).mockRejectedValue("offline");
  outside({ ...original, body: "Changed externally" });
  renderEditor(<DocumentEditor initial={original} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  const editor = screen.getByLabelText("Your thought");
  fireEvent.change(editor, { target: { value: "Local draft" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(editor.getAttribute("data-focus-request")).toBe("0");
  fireEvent.click(screen.getByRole("button", { name: "Reload saved content" }));
  expect(editor.getAttribute("data-focus-request")).toBe("1");
});

const doc = {
  id: "d1",
  title: "Checkout spec",
  body: "See T-KQ1 and T-KQ3.",
  created_at: "2026-11-04T00:00:00Z",
  updated_at: "2026-11-04T00:00:00Z",
  trashed: false,
};
it("shows the title once and edits it in place without a separate title field", () => {
  renderEditor(<DocumentEditor initial={doc} onClose={vi.fn()} />);
  expect(
    screen.getAllByRole("heading", { level: 1, name: "Checkout spec" }),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  expect(screen.queryByLabelText("Optional title")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Checkout spec",
  );
});
it("offers one breadcrumb back and no second back button", () => {
  const close = vi.fn();
  renderEditor(
    <DocumentEditor initial={doc} onClose={close} backLabel="Back to Plan" />,
  );
  expect(screen.getAllByRole("button", { name: /^Back to/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Back to Plan" }));
  expect(close).toHaveBeenCalledOnce();
});
it("keeps Link a Document, Create ticket and Context graph in Read and Edit", () => {
  renderEditor(
    <DocumentEditor initial={doc} onClose={vi.fn()} onOpenGraph={vi.fn()} />,
  );
  const names = () =>
    ["Link a Document", "Create ticket from this", "Open context graph"].map(
      (name) => screen.queryByRole("button", { name }) !== null,
    );
  expect(names()).toEqual([true, true, true]);
  fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
  expect(names()).toEqual([true, true, true]);
});
it("quotes a passage shared by several connections once", async () => {
  const link = (target: string) => ({
    source_id: "d1",
    target_id: target,
    source_kind: "document",
    target_kind: "ticket",
    source_label: "Checkout spec",
    target_label: target,
    source_trashed: false,
    target_trashed: false,
    passage: "See T-KQ1 and T-KQ3.",
  });
  vi.mocked(documents.links).mockResolvedValue([
    [link("T-KQ1"), link("T-KQ3")],
    [],
  ]);
  renderEditor(<DocumentEditor initial={doc} onClose={vi.fn()} />);
  await screen.findByRole("button", { name: "T-KQ1" });
  expect(screen.getAllByText(/See\s+T-KQ1/)).toHaveLength(2);
  expect(screen.getAllByText(/^Both from\s*“/)).toHaveLength(1);
});

it("opens the Document's History from its actions, and says when it Needs review", async () => {
  vi.mocked(syncReview.conflicts).mockResolvedValue([
    {
      kind: "document",
      id: "d1",
      reference: null,
      title: "Original",
      fields: ["body"],
      detected_at: "2026-11-11T18:41:00Z",
      read: false,
    },
  ]);
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  const notice = await screen.findByRole("region", { name: "Needs review" });
  expect(notice.textContent).toContain("Text was changed on two desktops.");
  expect(
    screen
      .getAllByRole("status")
      .some((status) => status.textContent === "Needs review"),
  ).toBe(true);
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Document actions" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "History…" }));
  expect(await screen.findByRole("dialog", { name: "History" })).toBeTruthy();
  expect(syncReview.versions).toHaveBeenCalledWith({
    kind: "document",
    id: "d1",
    source: "local",
  });
  expect(await screen.findByText("No earlier versions")).toBeTruthy();
});

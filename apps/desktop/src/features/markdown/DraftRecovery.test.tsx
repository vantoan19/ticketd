// @vitest-environment jsdom
import { createRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DraftRecoveryProvider } from "@/lib/draft-recovery";
import { useDraftRecovery } from "@/lib/draft-recovery-context";
import { WorkspaceBand } from "@/app/WorkspaceBand";
import { CreateTicketDialog } from "@/features/tickets/CreateTicketDialog";
import { DocumentEditor } from "@/features/documents/DocumentEditor";
import { Activity } from "@/features/tickets/Activity";
import { MarkdownEditor } from "./MarkdownEditor";
import { TicketEditor } from "@/features/tickets/TicketEditor";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeAll(async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  await import("./MarkdownEditor");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

function bridge(
  records = new Map<string, Record<string, unknown>>(),
  other?: (command: string, args: unknown) => unknown,
) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "draft_cutover_pending") return false;
    if (command === "draft_retentions") return [...records.values()];
    if (command === "retain_draft") {
      const draft = (args as { draft: Record<string, unknown> }).draft;
      const saved = { ...draft, revision: Number(draft.revision) + 1 };
      records.set(String(draft.owner), saved);
      return saved;
    }
    if (other) return other(command, args);
    if (command === "save_document" || command === "edit_activity")
      throw new Error("Database busy");
    return [];
  });
  return records;
}

async function typeSource(label: string, text: string) {
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  const source = await screen.findByRole("textbox", {
    name: `${label} source`,
  });
  act(() => {
    const view = EditorView.findFromDOM(source);
    view?.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      userEvent: "input",
    });
  });
}

test("unpublished new-ticket content is core-retained and recovers after a failed submission and restart", async () => {
  const records = new Map<string, Record<string, unknown>>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "draft_cutover_pending") return false;
    if (command === "draft_retentions") return [...records.values()];
    if (command === "retain_draft") {
      const draft = (args as { draft: Record<string, unknown> }).draft;
      const saved = { ...draft, revision: Number(draft.revision) + 1 };
      records.set(String(draft.owner), saved);
      return saved;
    }
    return [];
  });
  const create = vi.fn().mockRejectedValue(new Error("Database busy"));
  function Host() {
    return (
      <DraftRecoveryProvider>
        <CreateTicketDialog
          open
          onOpenChange={vi.fn()}
          triggerRef={createRef()}
          navigation={{ project: "all", plan: "" }}
          projects={[]}
          plans={[]}
          create={create}
        />
      </DraftRecoveryProvider>
    );
  }
  const first = render(<Host />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
    target: { value: "Recover me" },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  const source = await screen.findByRole("textbox", {
    name: "Description source",
  });
  act(() => {
    EditorView.findFromDOM(source)?.dispatch({
      changes: {
        from: 0,
        insert: "[Trace](ticketd://attachment/workspace/file)",
      },
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await screen.findByText(/Retry safely: it never creates a second ticket/);
  expect(create).toHaveBeenCalledWith(
    "Recover me",
    "[Trace](ticketd://attachment/workspace/file)",
    "Todo",
    null,
    null,
    [],
    false,
    expect.any(String),
    expect.any(Boolean),
  );
  await waitFor(() =>
    expect(records.get("new-ticket")?.markdown).toEqual([
      "[Trace](ticketd://attachment/workspace/file)",
    ]),
  );
  first.unmount();
  render(<Host />);
  expect(await screen.findByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Recover me",
  );
  expect(screen.getByText(/Draft restored/)).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: "Description rich text" }).textContent,
  ).toContain("Trace");
  expect(screen.getByRole("button", { name: "Discard draft" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(records.get("new-ticket")?.payload).toMatchObject({
    title: "Recover me",
    requestId: expect.any(String),
  });
});

test("description autosave releases the current draft while source Undo retains and restores its removed file link", async () => {
  const body = "[Authored trace label](ticketd://attachment/workspace/file)";
  let canonical: Ticket = {
    id: "t1",
    reference: "T-KQ1",
    title: "Keep Undo",
    body,
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    plan_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [],
  };
  const records = bridge(new Map(), (command, args) => {
    if (command === "change_ticket") {
      canonical = {
        ...canonical,
        ...(args as { patch: Partial<Ticket> }).patch,
      };
      return canonical;
    }
    return [];
  });
  function Host() {
    const [ticket, setTicket] = useState(canonical);
    return (
      <DraftRecoveryProvider>
        <TicketEditor ticket={ticket} onSaved={setTicket} />
      </DraftRecoveryProvider>
    );
  }
  render(<Host />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit description" }),
  );
  await typeSource("Description", "");
  await waitFor(() => expect(canonical.body).toBe(""));
  await waitFor(() => expect(records.get("ticket:t1")?.payload).toBeNull());
  expect([...records.values()].some((record) => record.kind === "undo")).toBe(
    true,
  );
  const source = screen.getByRole("textbox", { name: "Description source" });
  fireEvent.keyDown(source, { key: "z", code: "KeyZ", ctrlKey: true });
  await waitFor(() => expect(canonical.body).toBe(body));
  fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
  expect(
    screen.getByRole("textbox", { name: "Description rich text" }).textContent,
  ).toContain("Authored trace label");
});

test("Document Reload preserves the independently recoverable discarded draft until Undo restores it", async () => {
  const body = "[Discarded trace](ticketd://attachment/workspace/file)";
  const initial = {
    id: "d1",
    title: null,
    body: "External content",
    created_at: "2026-11-07",
    updated_at: "new",
    trashed: false,
  };
  const saved = { title: "", body: "Original content", suggestion: null };
  const draft = { title: "", body, suggestion: null };
  const records = bridge(
    new Map([
      [
        "document:d1",
        {
          owner: "document:d1",
          kind: "draft",
          revision: 1,
          payload: {
            draft,
            saved,
            id: "d1",
            revision: "old",
            pending: null,
            discarded: null,
            external: null,
            externalRevision: null,
          },
          markdown: [body],
        },
      ],
    ]),
    (command, args) => {
      if (command === "save_document") {
        const request = args as {
          expectedUpdatedAt: string;
          body: string | null;
        };
        if (request.expectedUpdatedAt !== initial.updated_at)
          throw { code: "conflict", message: "document changed elsewhere" };
        return {
          ...initial,
          body: request.body ?? initial.body,
          updated_at: "saved",
        };
      }
      if (command === "show_document") return initial;
      if (command === "document_context_links") return [[], []];
      return [];
    },
  );
  render(
    <DraftRecoveryProvider>
      <DocumentEditor initial={initial} onClose={vi.fn()} />
    </DraftRecoveryProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Reload saved content" }),
  );
  await waitFor(() =>
    expect(records.get("document:d1")?.payload).toMatchObject({
      discarded: { body },
      draft: { body: "External content" },
    }),
  );
  expect(records.get("document:d1")?.markdown).toContain(body);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Document rich text" }).textContent,
    ).toContain("Discarded trace"),
  );
  await waitFor(() =>
    expect(records.get("document:d1")?.payload).toMatchObject({
      draft: { body },
      discarded: null,
    }),
  );
});

test("recovered Document editing hides its repeated heading while retaining the canonical prefix", async () => {
  const link = "[Trace](ticketd://attachment/workspace/file)";
  const body = `# Heading\n\n${link}`;
  const initial = {
    id: "heading-doc",
    title: "Heading",
    body: "# Heading\n\nOriginal",
    created_at: "old",
    updated_at: "old",
    trashed: false,
  };
  const records = bridge(
    new Map([
      [
        "document:heading-doc",
        {
          owner: "document:heading-doc",
          kind: "draft",
          revision: 1,
          payload: {
            draft: { title: "Heading", body, suggestion: null },
            saved: { title: "Heading", body: initial.body, suggestion: null },
            id: initial.id,
            revision: "old",
            pending: null,
            discarded: null,
            external: null,
            externalRevision: null,
          },
          markdown: [body],
        },
      ],
    ]),
  );
  render(
    <DraftRecoveryProvider>
      <DocumentEditor initial={initial} onClose={vi.fn()} />
    </DraftRecoveryProvider>,
  );
  const editor = await screen.findByRole("textbox", {
    name: "Document rich text",
  });
  expect(editor.textContent).not.toContain("Heading");
  await typeSource(
    "Document",
    "[Changed](ticketd://attachment/workspace/file)",
  );
  await waitFor(() =>
    expect(records.get("document:heading-doc")?.payload).toMatchObject({
      draft: {
        body: "# Heading\n\n[Changed](ticketd://attachment/workspace/file)",
      },
    }),
  );
});

test("a failed Document capture keeps canonical recovery and its original create request through restart", async () => {
  const records = bridge();
  const first = render(
    <DraftRecoveryProvider>
      <DocumentEditor initial={null} onClose={vi.fn()} />
    </DraftRecoveryProvider>,
  );
  await typeSource(
    "Your thought",
    "[Trace](ticketd://attachment/workspace/file)",
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("save_document", expect.anything()),
  );
  await waitFor(() =>
    expect(records.get("document:capture")?.payload).toMatchObject({
      pending: { requestId: expect.any(String) },
    }),
  );
  const calls = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "save_document");
  const requestId = (calls[0]?.[1] as { requestId: string }).requestId;
  first.unmount();
  render(
    <DraftRecoveryProvider>
      <DocumentEditor initial={null} onClose={vi.fn()} />
    </DraftRecoveryProvider>,
  );
  expect(
    (await screen.findByRole("textbox", { name: "Your thought rich text" }))
      .textContent,
  ).toContain("Trace");
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "save_document"),
    ).toHaveLength(2),
  );
  expect(invoke).toHaveBeenLastCalledWith(
    "save_document",
    expect.objectContaining({
      requestId,
      body: "[Trace](ticketd://attachment/workspace/file)",
    }),
  );
});

test("an Activity edit recovers independently of an unpublished brief and details", async () => {
  const records = bridge(
    new Map([
      [
        "activity:T-KQ1",
        {
          owner: "activity:T-KQ1",
          kind: "draft",
          revision: 1,
          payload: {
            brief: "Unpublished brief",
            details: "[Detail](ticketd://attachment/workspace/file)",
            support: "",
          },
          markdown: ["[Detail](ticketd://attachment/workspace/file)"],
        },
      ],
      [
        "activity-edit:T-KQ1",
        {
          owner: "activity-edit:T-KQ1",
          kind: "draft",
          revision: 1,
          payload: {
            id: "a1",
            original: "Original",
            content: "[Edited](ticketd://attachment/workspace/file)",
          },
          markdown: ["[Edited](ticketd://attachment/workspace/file)"],
        },
      ],
    ]),
  );
  function Host() {
    return (
      <DraftRecoveryProvider>
        <Activity
          reference="T-KQ1"
          status="Todo"
          revision={0}
          projects={[]}
          active
          trashed={false}
        />
      </DraftRecoveryProvider>
    );
  }
  const first = render(<Host />);
  expect(
    (await screen.findByRole("textbox", { name: "Edit update rich text" }))
      .textContent,
  ).toContain("Edited");
  first.unmount();
  render(<Host />);
  expect(
    (await screen.findByRole("textbox", { name: "Edit update rich text" }))
      .textContent,
  ).toContain("Edited");
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  expect(
    (await screen.findByRole("textbox", { name: "New update rich text" }))
      .textContent,
  ).toContain("Unpublished brief");
  expect(
    screen.getByRole("textbox", { name: "Details rich text" }).textContent,
  ).toContain("Detail");
  await waitFor(() =>
    expect(records.get("activity-edit:T-KQ1")?.payload).toBeNull(),
  );
  expect(records.get("activity:T-KQ1")?.payload).toMatchObject({
    brief: "Unpublished brief",
  });
});

test("source Undo and rich/source transitions keep independent history protection after reference removal", async () => {
  const records = bridge();
  const body = "[Trace](ticketd://attachment/workspace/file)";
  function Editor() {
    const [value, setValue] = useState(body);
    return (
      <MarkdownEditor chrome="session" value={value} onChange={setValue} />
    );
  }
  const host = render(
    <DraftRecoveryProvider>
      <Editor />
    </DraftRecoveryProvider>,
  );
  await typeSource("Markdown document", "");
  await waitFor(() =>
    expect(
      [...records.values()].some(
        (record) =>
          record.kind === "undo" && (record.markdown as string[]).length === 0,
      ),
    ).toBe(true),
  );
  const source = screen.getByRole("textbox", {
    name: "Markdown document source",
  });
  fireEvent.keyDown(source, { key: "z", code: "KeyZ", ctrlKey: true });
  await waitFor(() => expect(source.textContent).toContain(body));
  fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
  expect(
    screen.getByRole("textbox", { name: "Markdown document rich text" })
      .textContent,
  ).toContain("Trace");
  const writes = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "retain_draft")
    .map(([, args]) => (args as { draft: Record<string, unknown> }).draft);
  expect(
    writes.some(
      (draft) =>
        draft.kind === "undo" && (draft.markdown as string[]).includes(body),
    ),
  ).toBe(true);
  expect(writes.some((draft) => draft.kind === "draft")).toBe(false);
  host.unmount();
  await waitFor(() =>
    expect(
      [...records.values()].filter((record) => record.kind === "undo"),
    ).toHaveLength(0),
  );
});

test("legacy draft import protects unopened owners and does not acknowledge other desktop profiles", async () => {
  const records = bridge();
  localStorage.setItem("ticketd:activity-draft:unopened", "Legacy brief");
  localStorage.setItem(
    "ticketd:activity-details:unopened",
    "[Details](ticketd://attachment/workspace/file)",
  );
  localStorage.setItem("ticketd:activity-support:other", "document-id");
  render(
    <DraftRecoveryProvider>
      <p>Workspace ready</p>
    </DraftRecoveryProvider>,
  );
  await screen.findByText("Workspace ready");
  expect(records.get("activity:unopened")?.payload).toMatchObject({
    brief: "Legacy brief",
    details: "[Details](ticketd://attachment/workspace/file)",
  });
  expect(records.get("activity:other")?.payload).toMatchObject({
    support: "document-id",
  });
  expect(invoke).not.toHaveBeenCalledWith("complete_draft_cutover");
  expect(localStorage.getItem("ticketd:activity-draft:unopened")).toBeNull();
});

test("distinct legacy profile drafts survive a primary recovery tombstone", async () => {
  const records = bridge(
    new Map([
      [
        "activity:T-KQ1",
        {
          owner: "activity:T-KQ1",
          kind: "draft",
          revision: 3,
          payload: null,
          markdown: [],
        },
      ],
    ]),
  );
  localStorage.setItem(
    "ticketd:activity-draft:T-KQ1",
    JSON.stringify({
      brief: "Other profile",
      details: "[Trace](ticketd://attachment/workspace/file)",
      support: "",
    }),
  );
  render(
    <DraftRecoveryProvider>
      <p>Workspace ready</p>
    </DraftRecoveryProvider>,
  );
  await screen.findByText("Workspace ready");
  expect(records.get("activity:T-KQ1")?.payload).toBeNull();
  const legacy = [...records.values()].find((record) =>
    String(record.owner).startsWith("legacy:"),
  );
  expect(legacy?.payload).toMatchObject({ brief: "Other profile" });
  expect(legacy?.markdown).toContain(
    "[Trace](ticketd://attachment/workspace/file)",
  );
  expect(localStorage.getItem("ticketd:activity-draft:T-KQ1")).toBeNull();
});

function Band() {
  const recovery = useDraftRecovery();
  return <WorkspaceBand onRetry={() => recovery.retry()} />;
}

test("failed draft protection is visible and blocks publication until explicit retry succeeds", async () => {
  let fail = true;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "draft_retentions") return [];
    if (command === "draft_cutover_pending") return false;
    if (command === "retain_draft") {
      if (fail) throw new Error("Recovery storage unavailable");
      const draft = (args as { draft: { revision: number } }).draft;
      return { ...draft, revision: draft.revision + 1 };
    }
    return [];
  });
  const create = vi.fn().mockResolvedValue("T-KQ1");
  render(
    <DraftRecoveryProvider>
      <Band />
      <CreateTicketDialog
        open
        onOpenChange={vi.fn()}
        triggerRef={createRef()}
        navigation={{ project: "all", plan: "" }}
        projects={[]}
        plans={[]}
        create={create}
      />
    </DraftRecoveryProvider>,
  );
  fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
    target: { value: "Keep my draft" },
  });
  // The workspace band says it once; the editor adds no second notice.
  await screen.findByText(/Unsaved drafts aren't protected right now/);
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await screen.findByText(/Your draft is kept on this device/);
  expect(create).not.toHaveBeenCalled();
  fail = false;
  // The open dialog hides the rest of the window from assistive technology.
  fireEvent.click(screen.getByRole("button", { name: "Retry", hidden: true }));
  await waitFor(() =>
    expect(
      screen.queryByText(/Unsaved drafts aren't protected right now/),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
});

test("late retention completion cannot publish or replace newer typing before it is durable", async () => {
  let releaseFirst: () => void = () => {};
  let first = true;
  const records = new Map<string, Record<string, unknown>>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "draft_retentions") return [];
    if (command === "draft_cutover_pending") return false;
    if (command === "retain_draft") {
      const draft = (args as { draft: Record<string, unknown> }).draft;
      if (draft.owner === "new-ticket" && first) {
        first = false;
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      const saved = { ...draft, revision: Number(draft.revision) + 1 };
      records.set(String(draft.owner), saved);
      return saved;
    }
    return [];
  });
  let finishCreate: (value: string) => void = () => {};
  const create = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finishCreate = resolve;
      }),
  );
  render(
    <DraftRecoveryProvider>
      <CreateTicketDialog
        open
        onOpenChange={vi.fn()}
        triggerRef={createRef()}
        navigation={{ project: "all", plan: "" }}
        projects={[]}
        plans={[]}
        create={create}
      />
    </DraftRecoveryProvider>,
  );
  const title = await screen.findByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: "Older" } });
  await waitFor(() => expect(first).toBe(false));
  fireEvent.change(title, { target: { value: "Newer" } });
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  expect(create).not.toHaveBeenCalled();
  await act(async () => {
    releaseFirst();
  });
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      "Newer",
      "",
      "Todo",
      null,
      null,
      [],
      false,
      expect.any(String),
      expect.any(Boolean),
    ),
  );
  expect(records.get("new-ticket")?.payload).toMatchObject({ title: "Newer" });
  await act(async () => {
    finishCreate("T-KQ1");
  });
});

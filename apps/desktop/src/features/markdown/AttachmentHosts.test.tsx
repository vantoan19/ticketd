// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { createRef } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, afterEach, beforeAll, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { TicketEditor } from "@/features/tickets/TicketEditor";
import { CreateTicketDialog } from "@/features/tickets/CreateTicketDialog";
import { Activity } from "@/features/tickets/Activity";
import { DocumentEditor } from "@/features/documents/DocumentEditor";
import type { Ticket } from "@/lib/api/client";
import { DraftRecoveryProvider } from "@/lib/draft-recovery";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
beforeAll(async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  await import("./MarkdownEditor");
});
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});
const file = {
  id: "file-1",
  display_name: "Trace",
  original_filename: "trace.log",
  size_bytes: 12,
  kind: "local_snapshot",
  locator: "file-1/bytes/trace.log",
};
const uri = "ticketd://attachment/workspace-1/file-1";
const link = `[Trace](${uri})`;
const ticket: Ticket = {
  id: "ticket-1",
  reference: "T-KQ1",
  title: "Investigate",
  body: "",
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
function bridge() {
  vi.mocked(open).mockResolvedValue("C:/trace.log");
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace-test";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "import_attachment") return file;
    if (command === "attachment_uri") return uri;
    if (
      [
        "change_ticket",
        "create_document",
        "change_document",
        "save_document",
        "add_activity_with_details",
      ].includes(command)
    )
      throw new Error("Database busy");
    return [];
  });
}
async function insertInto(label: string) {
  const editor = await screen.findByRole("region", { name: label });
  const editable = within(editor).getByRole("textbox");
  editable.focus();
  fireEvent.focus(editable);
  await waitFor(() => expect(document.activeElement).toBe(editable));
  fireEvent.click(
    within(editor).getByRole("button", { name: "Insert attachment" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Attach file" })).toBeNull(),
  );
  await waitFor(() => expect(editor.textContent).toContain("Trace"));
  await waitFor(() =>
    expect(document.activeElement).toBe(within(editor).getByRole("textbox")),
  );
}

test("reader replacement follows description autosave and retains the chosen occurrence after save failure", async () => {
  const nextUri = "ticketd://attachment/workspace-1/replacement";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace-1";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "resolve_attachment_uri") return file;
    if (command === "attachment_preview")
      return {
        attachment: file,
        status: "missing",
        media_type: null,
        message: "Stored bytes are missing",
        can_open: false,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    if (command === "search_attachments")
      return [{ ...file, id: "replacement", display_name: "Replacement" }].map(
        (attachment) => ({
          attachment,
          related: false,
          usage: {
            eligible: true,
            legacy_drafts_pending: false,
            protections: [],
          },
        }),
      );
    if (command === "inspect_attachment")
      return { ...file, id: "replacement", display_name: "Replacement" };
    if (command === "attachment_uri") return nextUri;
    if (command === "change_ticket") throw new Error("Database busy");
    return [];
  });
  const original = `${link} and [Keep](${uri})`;
  render(
    <TicketEditor ticket={{ ...ticket, body: original }} onSaved={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Trace" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose a replacement" }),
  );
  expect(invoke).not.toHaveBeenCalledWith("change_ticket", expect.anything());
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  fireEvent.click(
    await screen.findByRole("radio", { name: "Select Replacement" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  const expected = `[Trace](${nextUri}) and [Keep](${uri})`;
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "change_ticket",
      expect.objectContaining({
        patch: expect.objectContaining({ body: expected }),
      }),
    ),
  );
  expect(
    JSON.parse(localStorage.getItem("ticketd:ticket-draft:ticket-1") ?? "{}")
      .body,
  ).toBe(expected);
});

test.each(["reader", "rich"])(
  "%s replacement cannot acknowledge a new reference before durable recovery accepts it",
  async (mode) => {
    const nextUri = "ticketd://attachment/workspace-1/replacement";
    const records = new Map<string, Record<string, unknown>>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "attachment_upload_destination") return { kind: "local" };
      if (command === "begin_attachment_upload")
        return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
      if (command === "draft_cutover_pending") return false;
      if (command === "draft_retentions") return [...records.values()];
      if (command === "retain_draft") {
        const draft = (args as { draft: Record<string, unknown> }).draft;
        if (JSON.stringify(draft.markdown).includes(nextUri))
          throw new Error("Retention unavailable");
        const stored = { ...draft, revision: Number(draft.revision) + 1 };
        records.set(String(draft.owner), stored);
        return stored;
      }
      if (command === "attachment_workspace_id") return "workspace-1";
      if (command === "attachment_upload_limit") return 104857600;
      if (command === "resolve_attachment_uri") return file;
      if (command === "attachment_preview")
        return {
          attachment: file,
          status: "missing",
          media_type: null,
          message: "Stored bytes are missing",
          can_open: false,
          usage: { total: 1, entries: [], legacy_drafts_pending: false },
        };
      if (command === "search_attachments")
        return [
          { ...file, id: "replacement", display_name: "Replacement" },
        ].map((attachment) => ({
          attachment,
          related: false,
          usage: {
            eligible: true,
            legacy_drafts_pending: false,
            protections: [],
          },
        }));
      if (command === "inspect_attachment")
        return { ...file, id: "replacement", display_name: "Replacement" };
      if (command === "attachment_uri") return nextUri;
      return [];
    });
    render(
      <DraftRecoveryProvider>
        <TicketEditor ticket={{ ...ticket, body: link }} onSaved={vi.fn()} />
      </DraftRecoveryProvider>,
    );
    if (mode === "rich") {
      fireEvent.click(
        await screen.findByRole("button", { name: "Edit description" }),
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Preview attachment: Trace",
        }),
      );
    } else
      fireEvent.click(await screen.findByRole("button", { name: "Trace" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose a replacement" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
    fireEvent.click(
      await screen.findByRole("radio", { name: "Select Replacement" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
    await within(
      screen.getByRole("dialog", { name: "Attach file" }),
    ).findByText(/Retention unavailable/);
    expect(screen.getByRole("dialog", { name: "Attach file" })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("change_ticket", expect.anything());
  },
);

test("ticket descriptions autosave inserted links and retain the failed draft", async () => {
  bridge();
  render(<TicketEditor ticket={ticket} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Add a description…" }));
  await insertInto("Description");
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "change_ticket",
      expect.objectContaining({
        reference: "T-KQ1",
        patch: expect.objectContaining({ body: link }),
      }),
    ),
  );
  expect(
    JSON.parse(localStorage.getItem("ticketd:ticket-draft:ticket-1") ?? "{}")
      .body,
  ).toBe(link);
});

test("ticket creation inserts into its draft and submits only through Create", async () => {
  bridge();
  const create = vi.fn().mockRejectedValue(new Error("Database busy"));
  render(
    <CreateTicketDialog
      open
      onOpenChange={vi.fn()}
      triggerRef={createRef()}
      navigation={{ project: "all", plan: "" }}
      projects={[]}
      plans={[]}
      create={create}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Investigate" },
  });
  await insertInto("Description");
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      "Investigate",
      link,
      "Todo",
      null,
      null,
      [],
      false,
      expect.any(String),
      expect.any(Boolean),
    ),
  );
  expect(
    screen.getByRole("textbox", { name: "Description rich text" }).textContent,
  ).toContain("Trace");
});

test("Document capture autosaves inserted links while failed saves keep the draft", async () => {
  bridge();
  render(<DocumentEditor initial={null} onClose={vi.fn()} />);
  await insertInto("Your thought");
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "save_document",
      expect.objectContaining({ body: link }),
    ),
  );
  expect(
    screen.getByRole("textbox", { name: "Your thought rich text" }).textContent,
  ).toContain("Trace");
});

test("Activity brief and details insert links without posting until explicit submit", async () => {
  bridge();
  render(
    <Activity
      reference="T-KQ1"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  await insertInto("New update");
  if (screen.queryByRole("button", { name: "Add details" }))
    fireEvent.click(screen.getByRole("button", { name: "Add details" }));
  else {
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Add details or a Document" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Add details" }),
    );
  }
  await insertInto("Details");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "add_activity_with_details"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Post update" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "add_activity_with_details",
      expect.objectContaining({
        reference: "T-KQ1",
        brief: link,
        details: link,
      }),
    ),
  );
  await screen.findByRole("alert");
  expect(
    JSON.parse(localStorage.getItem("ticketd:activity-draft:T-KQ1") ?? "{}"),
  ).toMatchObject({ brief: link, details: link });
});

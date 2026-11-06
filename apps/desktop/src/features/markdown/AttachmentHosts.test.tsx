// @vitest-environment jsdom
import { createRef } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { TicketEditor } from "@/features/tickets/TicketEditor";
import { CreateTicketDialog } from "@/features/tickets/CreateTicketDialog";
import { Activity } from "@/features/tickets/Activity";
import { DocumentEditor } from "@/features/documents/DocumentEditor";
import type { Ticket } from "@/lib/api/client";

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
  reference: "T-1",
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
  vi.mocked(invoke).mockImplementation(async (command) => {
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

test("ticket descriptions autosave inserted links and retain the failed draft", async () => {
  bridge();
  render(<TicketEditor ticket={ticket} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Add a description…" }));
  await insertInto("Description");
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "change_ticket",
      expect.objectContaining({
        reference: "T-1",
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
      reference="T-1"
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
      expect.objectContaining({ reference: "T-1", brief: link, details: link }),
    ),
  );
  await screen.findByRole("alert");
  expect(
    JSON.parse(localStorage.getItem("ticketd:activity-draft:T-1") ?? "{}"),
  ).toMatchObject({ brief: link, details: link });
});

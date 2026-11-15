// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { TicketFiles as TicketAttachments } from "./TicketFiles";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
Element.prototype.scrollIntoView ??= () => {};
/** Files' Attach menu → File…: the row when empty, the "+" otherwise. */
async function attachFile() {
  const trigger = (
    await screen.findAllByRole("button", { name: /^Attach/ })
  )[0]!;
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "File…" }));
}

test.each(["close", "navigate"])(
  "%s during upload retains the completed file without associating it",
  async (action) => {
    vi.mocked(open).mockResolvedValue("C:/trace.log");
    let complete: ((value: typeof file) => void) | undefined;
    const stored = new Promise<typeof file>((resolve) => {
      complete = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "attachment_upload_destination" ||
      command === "begin_attachment_upload"
        ? { kind: "local" }
        : command === "attachment_workspace_id"
          ? "workspace-test"
          : command === "attachment_upload_limit"
            ? 104857600
            : command === "import_attachment"
              ? stored
              : [],
    );
    const view = render(
      <TicketAttachments
        ticket={ticket}
        revision={0}
        refresh={async () => {}}
      />,
    );
    await attachFile();
    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "import_attachment",
        expect.anything(),
      ),
    );
    if (action === "close")
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    else view.unmount();
    await act(async () => {
      complete?.(file);
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "set_ticket_attachment",
      expect.anything(),
    );
  },
);
const ticket = { reference: "T-KQ1", id: "t1", trashed: false } as Ticket;
const file = {
  id: "f1",
  display_name: "Trace",
  original_filename: "trace.log",
  size_bytes: 7,
  kind: "local_snapshot",
  locator: "f1/bytes/trace.log",
};

test("the direct attachment rail distinguishes uploaded copies", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "ticket_attachments")
      return [{ ...file, kind: "external_reference", uploaded_copy: true }];
    return [];
  });
  render(
    <TicketAttachments ticket={ticket} revision={0} refresh={async () => {}} />,
  );
  await screen.findByRole("button", { name: "Trace" });
  expect(screen.getByText("Google Drive · Uploaded copy")).toBeTruthy();
  expect(screen.queryByText("Google Drive · External reference")).toBeNull();
});

test("a direct preview replaces only its selected ticket association through the atomic operation", async () => {
  const replacement = { ...file, id: "new-file", display_name: "New trace" };
  let replaced = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace-test";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "ticket_attachments")
      return replaced ? [replacement] : [file];
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
      return [replacement].map((attachment) => ({
        attachment,
        related: false,
        usage: {
          eligible: true,
          legacy_drafts_pending: false,
          protections: [],
        },
      }));
    if (command === "inspect_attachment") return replacement;
    if (command === "replace_ticket_attachment") {
      replaced = true;
      return null;
    }
    return null;
  });
  render(
    <TicketAttachments ticket={ticket} revision={0} refresh={async () => {}} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Trace" }));
  await screen.findByText("The local file could not be found");
  fireEvent.click(screen.getByRole("button", { name: "Choose a replacement" }));
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  fireEvent.click(
    await screen.findByRole("radio", { name: "Select New trace" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  await screen.findByRole("button", { name: "New trace" });
  expect(invoke).toHaveBeenCalledWith("replace_ticket_attachment", {
    reference: "T-KQ1",
    previousId: "f1",
    replacementId: "new-file",
    requestId: expect.any(String),
  });
  expect(invoke).not.toHaveBeenCalledWith(
    "set_ticket_attachment",
    expect.anything(),
  );
});

test("the rail uploads through the native picker, then associates the stored snapshot", async () => {
  vi.mocked(open).mockResolvedValue("C:/trace.log");
  let linked = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace-test";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "ticket_attachments") return linked ? [file] : [];
    if (command === "import_attachment") return file;
    if (command === "set_ticket_attachment") {
      linked = true;
      return ticket;
    }
    return [];
  });
  render(
    <TicketAttachments ticket={ticket} revision={0} refresh={async () => {}} />,
  );
  await attachFile();
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  await screen.findByRole("button", { name: "Trace" });
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ directory: false, multiple: true }),
  );
  expect(invoke).toHaveBeenCalledWith("import_attachment", {
    source: "C:/trace.log",
    requestId: expect.any(String),
    progress: expect.anything(),
  });
  expect(invoke).toHaveBeenCalledWith("set_ticket_attachment", {
    reference: "T-KQ1",
    attachmentId: "f1",
    present: true,
    requestId: expect.any(String),
  });
  expect(invoke).not.toHaveBeenCalledWith("open_attachment", expect.anything());
});

test("a failed association retains the completed upload and retry links the same ID", async () => {
  vi.mocked(open).mockResolvedValue("C:/trace.log");
  let attempts = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace-test";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "ticket_attachments") return attempts > 1 ? [file] : [];
    if (command === "import_attachment" || command === "inspect_attachment")
      return file;
    if (command === "set_ticket_attachment") {
      if (++attempts === 1) throw new Error("database busy");
      return ticket;
    }
    return [];
  });
  render(
    <TicketAttachments ticket={ticket} revision={0} refresh={async () => {}} />,
  );
  await attachFile();
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  await screen.findByText(/Stored as f1/);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Trace" });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "import_attachment"),
  ).toHaveLength(1);
  const links = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "set_ticket_attachment");
  expect(links[1]?.[1]).toEqual(links[0]?.[1]);
});

test("metadata offers explicit native open, byte export and reference-only detach", async () => {
  vi.mocked(save).mockResolvedValue("C:/export.log");
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "ticket_attachments"
      ? [file]
      : command === "set_ticket_attachment"
        ? ticket
        : null,
  );
  render(
    <TicketAttachments ticket={ticket} revision={0} refresh={async () => {}} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Trace" }));
  expect(screen.getByText("trace.log")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("open_attachment", { id: "f1" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Export file" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("export_attachment", {
      id: "f1",
      destination: "C:/export.log",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Detach from ticket" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "set_ticket_attachment",
      expect.objectContaining({ attachmentId: "f1", present: false }),
    ),
  );
});

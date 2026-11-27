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
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { TicketFiles as TicketAttachments } from "./TicketFiles";
import type { Ticket } from "@/lib/api/client";
import { TestOpenTicket } from "@/features/tickets/open-ticket/testing";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = () => {};
  },
  convertFileSrc: (value: string) =>
    `http://attachment-media.localhost/${value}`,
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
      <TestOpenTicket ticket={ticket}>
        <TicketAttachments />
      </TestOpenTicket>,
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
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
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
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Trace" }));
  await screen.findByText("Missing from this computer");
  fireEvent.click(screen.getByRole("button", { name: "Replace file…" }));
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
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
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
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
  );
  await attachFile();
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
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
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Trace" }));
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
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Detach from ticket" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "set_ticket_attachment",
      expect.objectContaining({ attachmentId: "f1", present: false }),
    ),
  );
});

test("closing the viewer returns focus to the file that opened it", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "ticket_attachments" ? [file] : null,
  );
  render(
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
  );
  const row = await screen.findByRole("button", { name: "Trace" });
  row.focus();
  fireEvent.click(row);
  const viewer = await screen.findByRole("dialog");
  // The stage takes focus when the viewer opens, so the reading keys work at once.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("group", { name: /^Trace, / }),
    ),
  );
  fireEvent.keyDown(viewer, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(row);
});

test("detaching the open file lands focus on the Files heading", async () => {
  let attached = [file];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "ticket_attachments") return attached;
    if (command === "document_context_links") return [[], []];
    if (command === "set_ticket_attachment") {
      attached = (args as { present: boolean }).present ? [file] : [];
      return ticket;
    }
    return null;
  });
  render(
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
  );
  const row = await screen.findByRole("button", { name: "Trace" });
  row.focus();
  fireEvent.click(row);
  await screen.findByRole("dialog");
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Detach from ticket" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Files" }),
    ),
  );
});

test("detaching the last file lands focus on the File button when the empty section is hidden", async () => {
  let attached = [file];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "ticket_attachments") return attached;
    if (command === "document_context_links") return [[], []];
    if (command === "set_ticket_attachment") {
      attached = (args as { present: boolean }).present ? [file] : [];
      return ticket;
    }
    return null;
  });
  // The ticket page gives an empty section's File button a place in its header.
  const header = document.body.appendChild(document.createElement("span"));
  render(
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments emptyTarget={header} />
    </TestOpenTicket>,
  );
  const row = await screen.findByRole("button", { name: "Trace" });
  row.focus();
  fireEvent.click(row);
  await screen.findByRole("dialog");
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Detach from ticket" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(header.querySelector("button")),
  );
  header.remove();
});

test("detaching the open file lands focus on the Files heading even when the files are read again slowly", async () => {
  let attached = [file];
  let release: () => void = () => {};
  let slow = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "ticket_attachments") {
      const now = attached;
      // After the detach the read is slow: the card outlives the viewer.
      if (slow) await new Promise<void>((resolve) => (release = resolve));
      return now;
    }
    if (command === "set_ticket_attachment") {
      attached = (args as { present: boolean }).present ? [file] : [];
      slow = true;
      return ticket;
    }
    return null;
  });
  render(
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
  );
  const row = await screen.findByRole("button", { name: "Trace" });
  row.focus();
  fireEvent.click(row);
  await screen.findByRole("dialog");
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Detach from ticket" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // The card is still there, so focus went back to it...
  await waitFor(() => expect(document.activeElement).toBe(row));
  // ...and when the card goes, focus does not fall to the body.
  await act(async () => release());
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Files" }),
    ),
  );
});

test("Files shows cards for a mixed set, with a tile for the file that has no still, and the keyboard opens the viewer", async () => {
  const user = userEvent.setup();
  const shot = {
    ...file,
    id: "shot",
    display_name: "refund-after-fix.png",
    original_filename: "refund-after-fix.png",
    size_bytes: 99328,
  };
  const away = {
    ...file,
    id: "away",
    display_name: "load-test.html",
    original_filename: "load-test.html",
    size_bytes: 3563110,
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "ticket_attachments") return [shot, file, away];
    if (command === "attachment_workspace_id") return "workspace-test";
    if (command === "attachment_availability")
      return [{ id: "away", state: "not_downloaded", progress: null }];
    if (command === "attachment_preview") {
      const picture = (args as { id?: string }).id === "shot";
      return {
        attachment: picture ? shot : file,
        status: picture ? "available" : "unsupported",
        media_type: picture ? "image/png" : null,
        message: null,
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    }
    return null;
  });
  render(
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
  );
  const cards = await screen.findAllByRole("button", { name: /\.|Trace/ });
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
    "refund-after-fix.png",
    "Trace",
    "load-test.html",
  ]);
  expect(screen.getByText("PNG image · 97 KB")).toBeTruthy();
  expect(screen.getByText("Log · 7 B")).toBeTruthy();
  // A file that isn't here keeps its labeled tile and says why.
  await screen.findByText("Not downloaded · 3.4 MB");
  expect(invoke).not.toHaveBeenCalledWith("attachment_html", expect.anything());
  // Tab reaches a card and Enter opens the viewer; Esc returns focus to it.
  await user.tab();
  await user.tab();
  const log = screen.getByRole("button", { name: "Trace" });
  while (document.activeElement !== log) await user.tab();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(log);
});

test("eight files and no Documents fold after six cards", async () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    ...file,
    id: `f${index}`,
    display_name: `file-${index}.zip`,
    original_filename: `file-${index}.zip`,
  }));
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "ticket_attachments") return many;
    if (command === "attachment_workspace_id") return "workspace-test";
    if (command === "attachment_availability") return [];
    return null;
  });
  render(
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
  );
  const more = await screen.findByRole("button", { name: /Show all 8 files/ });
  expect(screen.queryByRole("button", { name: "file-6.zip" })).toBeNull();
  fireEvent.click(more);
  expect(screen.getByRole("button", { name: "file-7.zip" })).toBeTruthy();
});

test("opening the middle file steps both ways, and Esc returns to the card that opened it", async () => {
  const user = userEvent.setup();
  const first = { ...file, id: "a", display_name: "alpha.log" };
  const middle = { ...file, id: "b", display_name: "beta.log" };
  const last = { ...file, id: "c", display_name: "gamma.log" };
  const all = [first, middle, last];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "ticket_attachments") return all;
    if (command === "attachment_workspace_id") return "workspace-test";
    if (command === "attachment_preview")
      return {
        attachment: all.find((item) => item.id === (args as { id: string }).id),
        status: "unsupported",
        media_type: null,
        message: null,
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    return null;
  });
  render(
    <TestOpenTicket ticket={ticket}>
      <TicketAttachments />
    </TestOpenTicket>,
  );
  const card = await screen.findByRole("button", { name: "beta.log" });
  card.focus();
  await user.click(card);
  await screen.findByRole("dialog");
  expect(screen.getByText("2 of 3")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Next file" }));
  expect(
    await screen.findByRole("heading", { name: "gamma.log" }),
  ).toBeTruthy();
  expect(screen.getByText("3 of 3")).toBeTruthy();
  await user.keyboard("k");
  await user.keyboard("k");
  expect(
    await screen.findByRole("heading", { name: "alpha.log" }),
  ).toBeTruthy();
  expect(screen.getByText("1 of 3")).toBeTruthy();
  // The card of the file the viewer was opened from, not the one shown last.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(card);
});

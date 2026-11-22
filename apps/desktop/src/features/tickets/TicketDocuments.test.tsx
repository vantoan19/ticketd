// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TicketFiles as TicketDocuments } from "@/features/tickets/TicketFiles";
import type { Ticket } from "@/lib/api/client";
import { Backlinks } from "@/features/tickets/Backlinks";
import { TestOpenTicket } from "@/features/tickets/open-ticket/testing";
import {
  StatusLineContext,
  type StatusLineMessage,
} from "@/components/ui/use-status-line";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// The Document picker's list (cmdk) scrolls the highlighted row into view.
Element.prototype.scrollIntoView ??= () => {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ticket = {
  id: "t1",
  reference: "T-KQ1",
  title: "Work",
  body: "Description",
} as Ticket;
const files = (onOpenUpdate?: (activityId: string) => void) => (
  <TestOpenTicket ticket={ticket}>
    <TicketDocuments {...(onOpenUpdate && { onOpenUpdate })} />
  </TestOpenTicket>
);
const link = (id: string, label: string, explicit: boolean) => ({
  source_id: "t1",
  target_id: id,
  source_kind: "ticket",
  target_kind: "document",
  passage: "",
  source_label: "T-KQ1",
  target_label: label,
  source_trashed: false,
  target_trashed: false,
  explicit,
});

test("unlinking removes only an explicit reference and a mention offers Edit description", async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === "document_context_links"
        ? [[link("d1", "Linked", true), link("d2", "Mentioned", false)], []]
        : command === "ticket_attachments"
          ? []
          : null,
    ),
  );
  const edit = vi.fn();
  window.addEventListener("ticketd:edit-description", edit);
  render(files());
  fireEvent.click(await screen.findByRole("button", { name: "Remove Linked" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_ticket_document", {
      reference: "T-KQ1",
      documentId: "d1",
      present: false,
      requestId: expect.any(String),
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith("change_ticket", expect.anything());
  expect(screen.queryByRole("button", { name: "Remove Mentioned" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Edit description to remove Mentioned",
    }),
  );
  expect(edit).toHaveBeenCalled();
  window.removeEventListener("ticketd:edit-description", edit);
});

test("attaching Activity details from the picker links them without a separate keep call", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "document_context_links") return Promise.resolve([[], []]);
    if (command === "recent_documents")
      return Promise.resolve([
        { id: "d9", heading: "Trace", origin_ticket: "T-KQ11" },
      ]);
    return Promise.resolve(command === "ticket_attachments" ? [] : null);
  });
  render(files());
  // Empty Files: one "Attach…" row opens File… / Document….
  fireEvent.pointerDown(
    await screen.findByRole("button", { name: "Attach…" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Document…" }));
  fireEvent.click(await screen.findByText("T-KQ11 · Update details"));
  expect(invoke).toHaveBeenCalledWith("recent_documents", {
    offset: 0,
    includeSupport: true,
  });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_ticket_document", {
      reference: "T-KQ1",
      documentId: "d9",
      present: true,
      requestId: expect.any(String),
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith("keep_document", expect.anything());
});

test("a Document mentioned only by an update says so and opens that update", async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === "document_context_links"
        ? [[{ ...link("d3", "Trace", false), activity_id: "a1" }], []]
        : command === "ticket_attachments"
          ? []
          : null,
    ),
  );
  const open = vi.fn();
  render(files(open));
  fireEvent.click(
    await screen.findByRole("button", { name: "Go to the update" }),
  );
  expect(open).toHaveBeenCalledWith("a1");
  expect(screen.queryByRole("button", { name: /Edit description/ })).toBeNull();
});

test("a failed read says so with Retry instead of reading as no Documents", async () => {
  let readable = false;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command !== "document_context_links")
      return Promise.resolve(command === "ticket_attachments" ? [] : null);
    return readable
      ? Promise.resolve([[link("d1", "Linked", true)], []])
      : Promise.reject({ code: "failed", message: "disk I/O error" });
  });
  render(files());
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't load Documents",
  );
  readable = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Linked" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("returning to the window does not read the files again", async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === "document_context_links"
        ? [[link("d1", "Linked", true)], []]
        : command === "ticket_attachments"
          ? []
          : null,
    ),
  );
  render(files());
  await screen.findByRole("button", { name: "Linked" });
  const reads = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) =>
          command === "document_context_links" ||
          command === "ticket_attachments",
      ).length;
  const before = reads();
  window.dispatchEvent(new Event("focus"));
  for (let turn = 0; turn < 3; turn += 1) await act(async () => {});
  expect(reads()).toBe(before);
});

test("Files and Backlinks read the Ticket's links to Documents once", async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === "document_context_links"
        ? [[link("d1", "Linked", true)], []]
        : command === "ticket_attachments" || command === "ticket_backlinks"
          ? []
          : null,
    ),
  );
  render(
    <TestOpenTicket ticket={ticket}>
      <TicketDocuments />
      <Backlinks select={() => {}} />
    </TestOpenTicket>,
  );
  await screen.findByRole("button", { name: "Linked" });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("ticket_backlinks", expect.anything()),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "document_context_links"),
  ).toHaveLength(1);
});

test("a Document attached from the picker appears once the change is reported", async () => {
  let attached = false;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "document_context_links")
      return Promise.resolve([attached ? [link("d9", "Trace", true)] : [], []]);
    if (command === "set_ticket_document") {
      attached = true;
      return Promise.resolve(null);
    }
    if (command === "recent_documents")
      return Promise.resolve([
        { id: "d9", heading: "Trace", origin_ticket: "T-KQ11" },
      ]);
    return Promise.resolve(command === "ticket_attachments" ? [] : null);
  });
  render(files());
  fireEvent.pointerDown(
    await screen.findByRole("button", { name: "Attach…" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Document…" }));
  fireEvent.click(await screen.findByText("T-KQ11 · Update details"));
  expect(await screen.findByRole("button", { name: "Trace" })).toBeTruthy();
});

test("a Document whose removal failed comes back", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "document_context_links")
      return Promise.resolve([[link("d1", "Linked", true)], []]);
    if (command === "set_ticket_document")
      return Promise.reject({ code: "failed", message: "disk I/O error" });
    return Promise.resolve(command === "ticket_attachments" ? [] : null);
  });
  render(files());
  fireEvent.click(await screen.findByRole("button", { name: "Remove Linked" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't remove the Document",
  );
  expect(screen.getByRole("button", { name: "Linked" })).toBeTruthy();
});

test("Undo of a removal shows the Document again even when the re-read after the removal failed", async () => {
  let attached = true;
  let failNextRead = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "document_context_links") {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("database is busy");
      }
      return [attached ? [link("d1", "Linked", true)] : [], []];
    }
    if (command === "set_ticket_document") {
      attached = (args as { present: boolean }).present;
      // The re-read right after the removal fails, so the list read still holds
      // the Document and the read after Undo returns the very same data.
      failNextRead = !attached;
      return null;
    }
    return command === "ticket_attachments" ? [] : null;
  });
  let message: StatusLineMessage | null = null;
  const line = {
    show: (next: StatusLineMessage) => {
      message = next;
    },
    dismiss: () => {},
    setInset: () => {},
  };
  render(<StatusLineContext value={line}>{files()}</StatusLineContext>);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Linked" }));
  await waitFor(() => expect(message?.undo).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Linked" })).toBeNull();
  await act(async () => {
    await (message as StatusLineMessage | null)?.undo?.();
  });
  expect(await screen.findByRole("button", { name: "Linked" })).toBeTruthy();
});

test("Undo of a removal shows the Document again and keeps it when the re-read after Undo fails", async () => {
  let attached = true;
  let failReads = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "document_context_links") {
      if (failReads) throw new Error("database is busy");
      return [attached ? [link("d1", "Linked", true)] : [], []];
    }
    if (command === "set_ticket_document") {
      attached = (args as { present: boolean }).present;
      return null;
    }
    return command === "ticket_attachments" ? [] : null;
  });
  let message: StatusLineMessage | null = null;
  const line = {
    show: (next: StatusLineMessage) => {
      message = next;
    },
    dismiss: () => {},
    setInset: () => {},
  };
  render(<StatusLineContext value={line}>{files()}</StatusLineContext>);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Linked" }));
  await waitFor(() => expect(message?.undo).toBeTruthy());
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Linked" })).toBeNull();

  failReads = true;
  await act(async () => {
    await (message as StatusLineMessage | null)?.undo?.();
  });
  expect(screen.getByRole("button", { name: "Linked" })).toBeTruthy();
  expect(attached).toBe(true);
});

test("Remove hides the Document at once and a second click sends no second write", async () => {
  let finish: () => void = () => {};
  const written = new Promise<null>((resolve) => {
    finish = () => resolve(null);
  });
  vi.mocked(invoke).mockImplementation((command) =>
    command === "document_context_links"
      ? Promise.resolve([[link("d1", "Linked", true)], []])
      : command === "set_ticket_document"
        ? written
        : Promise.resolve(command === "ticket_attachments" ? [] : null),
  );
  render(files());
  const remove = await screen.findByRole("button", { name: "Remove Linked" });
  act(() => {
    remove.click();
    remove.click();
  });
  expect(screen.queryByRole("button", { name: "Linked" })).toBeNull();
  await act(async () => finish());
  const writes = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "set_ticket_document");
  expect(writes).toHaveLength(1);
});

test("a failed Remove shows the Document again with the error", async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    command === "document_context_links"
      ? Promise.resolve([[link("d1", "Linked", true)], []])
      : command === "set_ticket_document"
        ? Promise.reject({ code: "failed", message: "disk I/O error" })
        : Promise.resolve(command === "ticket_attachments" ? [] : null),
  );
  render(files());
  fireEvent.click(await screen.findByRole("button", { name: "Remove Linked" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Linked" })).toBeTruthy();
});

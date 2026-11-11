// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TicketDocuments } from "@/features/tickets/TicketDocuments";
import type { Ticket } from "@/lib/api/client";

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
        : null,
    ),
  );
  const refresh = vi.fn(() => Promise.resolve());
  const edit = vi.fn();
  window.addEventListener("ticketd:edit-description", edit);
  render(<TicketDocuments ticket={ticket} revision={0} refresh={refresh} />);
  fireEvent.click(await screen.findByRole("button", { name: "Unlink Linked" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_ticket_document", {
      reference: "T-KQ1",
      documentId: "d1",
      present: false,
      requestId: expect.any(String),
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith("change_ticket", expect.anything());
  expect(screen.queryByRole("button", { name: "Unlink Mentioned" })).toBeNull();
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
    return Promise.resolve(null);
  });
  render(
    <TicketDocuments
      ticket={ticket}
      revision={0}
      refresh={() => Promise.resolve()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Add Document" }));
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
        : null,
    ),
  );
  const open = vi.fn();
  render(
    <TicketDocuments
      ticket={ticket}
      revision={0}
      refresh={() => Promise.resolve()}
      onOpenUpdate={open}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "From update" }));
  expect(open).toHaveBeenCalledWith("a1");
  expect(screen.queryByRole("button", { name: /Edit description/ })).toBeNull();
});

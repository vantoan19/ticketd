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
  reference: "T-1",
  title: "Work",
  body: "Description",
} as Ticket;
const link = (id: string, label: string, explicit: boolean) => ({
  source_id: "t1",
  target_id: id,
  source_kind: "ticket",
  target_kind: "document",
  passage: "",
  source_label: "T-1",
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
      reference: "T-1",
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

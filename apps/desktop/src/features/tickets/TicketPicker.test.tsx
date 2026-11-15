// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TicketPicker } from "@/features/tickets/TicketPicker";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function ticket(reference: string, title: string): Ticket {
  return {
    id: reference,
    reference,
    title,
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    plan_id: null,
    availability: null,
    parent: null,
    children: [],
    prerequisites: [],
  };
}

test("an exact reference leads the results and a pick returns the ticket", async () => {
  // Search matches the text "t-kq12" inside another ticket; the exact
  // reference must still come first (list F-07, chat CH-47).
  vi.mocked(invoke).mockImplementation(async (command: string) =>
    command === "show_ticket"
      ? ticket("T-KQ12", "Export CSV")
      : [ticket("T-KQ3", "Mentions T-KQ12 in passing")],
  );
  const onPick = vi.fn();
  render(<TicketPicker onPick={onPick} />);
  fireEvent.change(
    screen.getByLabelText("Search tickets by title or reference"),
    { target: { value: "t-kq12" } },
  );
  const rows = await screen.findAllByRole("option");
  expect(rows.map((row) => row.textContent)).toEqual([
    "T-KQ12Export CSV",
    "T-KQ3Mentions T-KQ12 in passing",
  ]);
  fireEvent.click(rows[0]!);
  expect(onPick).toHaveBeenCalledWith(
    expect.objectContaining({ reference: "T-KQ12" }),
  );
});

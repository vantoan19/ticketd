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
import { Duplicates } from "@/features/tickets/Duplicates";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("marks a duplicate and refreshes the ticket", async () => {
  const ticket: Ticket = {
    id: "1",
    reference: "T-1",
    title: "Source",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    effort_id: null,
    availability: "Ready",
    parent: null,
    children: [],
    prerequisites: [],
  };
  vi.mocked(invoke).mockResolvedValue({
    ...ticket,
    status: "Canceled",
    duplicate_of: "T-2",
  });
  const refresh = vi.fn(async () => {});
  render(<Duplicates ticket={ticket} refresh={refresh} select={() => {}} />);
  fireEvent.change(screen.getByLabelText("Canonical ticket reference"), {
    target: { value: "T-2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Mark duplicate" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledWith(
    "mark_duplicate",
    expect.objectContaining({ source: "T-1", canonical: "T-2" }),
  );
});

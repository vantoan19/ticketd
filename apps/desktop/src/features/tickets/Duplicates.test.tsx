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
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "preview_duplicate_dependencies")
      return {
        canonical: "T-2",
        edges: [
          {
            blocker: "T-1",
            dependent: "T-3",
            replacement_blocker: "T-2",
            replacement_dependent: "T-3",
          },
        ],
      };
    return { ...ticket, status: "Canceled", duplicate_of: "T-2" };
  });
  const refresh = vi.fn(async () => {});
  render(<Duplicates ticket={ticket} refresh={refresh} select={() => {}} />);
  fireEvent.change(screen.getByLabelText("Canonical ticket reference"), {
    target: { value: "T-2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview dependencies" }));
  const choice = await screen.findByLabelText("Choice for T-1 blocks T-3");
  expect(
    (
      screen.getByRole("button", {
        name: "Mark duplicate",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(choice, { target: { value: "retain" } });
  fireEvent.click(screen.getByRole("button", { name: "Mark duplicate" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledWith(
    "mark_duplicate_reviewed",
    expect.objectContaining({
      source: "T-1",
      canonical: "T-2",
      decisions: [expect.objectContaining({ choice: "retain" })],
    }),
  );
});

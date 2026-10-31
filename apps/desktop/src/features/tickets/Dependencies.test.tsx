// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Dependencies } from "@/features/tickets/Dependencies";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

test("identifies canceled prerequisites as unresolved and opens the related ticket", () => {
  const select = vi.fn();
  const ticket: Ticket = {
    id: "1",
    reference: "T-1",
    title: "Dependent",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    effort_id: null,
    availability: "Blocked",
    parent: null,
    children: [],
    prerequisites: [
      {
        reference: "T-2",
        title: "Canceled blocker",
        status: "Canceled",
        trashed: false,
      },
    ],
  };
  render(
    <Dependencies ticket={ticket} refresh={async () => {}} select={select} />,
  );
  expect(screen.getByText(/Canceled · Unresolved/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /T-2 Canceled blocker/ }));
  expect(select).toHaveBeenCalledWith("T-2", false);
});

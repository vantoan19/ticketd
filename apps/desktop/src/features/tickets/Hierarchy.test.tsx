// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Hierarchy } from "@/features/tickets/Hierarchy";
import type { Ticket } from "@/lib/api/client";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

test("removing a subticket preserves both relationship drafts", async () => {
  const ticket: Ticket = {
    id: "1",
    reference: "T-1",
    title: "First",
    body: "",
    status: "Todo",
    trashed: false,
    tags: [],
    project_id: null,
    effort_id: null,
    availability: "Ready",
    prerequisites: [],
    parent: null,
    children: [{ reference: "T-2", title: "Child", trashed: false }],
  };
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "show_ticket" ? ticket : undefined,
  );
  render(
    <Hierarchy
      ticket={ticket}
      refresh={async () => {}}
      select={() => {}}
      revision={0}
    />,
  );
  fireEvent.change(screen.getByLabelText("Parent reference"), {
    target: { value: "T-3" },
  });
  fireEvent.change(screen.getByLabelText("Subticket reference"), {
    target: { value: "T-4" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Remove T-2" }));
  });
  expect(screen.getByLabelText("Parent reference")).toHaveProperty(
    "value",
    "T-3",
  );
  expect(screen.getByLabelText("Subticket reference")).toHaveProperty(
    "value",
    "T-4",
  );
});

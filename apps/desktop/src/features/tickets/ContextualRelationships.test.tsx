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
import { ContextualRelationships } from "@/features/tickets/ContextualRelationships";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("adds a discovery and opens a related ticket", async () => {
  const ticket: Ticket = {
    id: "1",
    reference: "T-1",
    title: "Work",
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
  const page = { items: [], next_offset: null };
  const relationships = {
    related: {
      items: [
        {
          reference: "T-2",
          title: { text: "Other" },
          status: "Todo",
          trashed: false,
        },
      ],
      next_offset: null,
    },
    discovered_while: page,
    discoveries: page,
  };
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "contextual_relationships" ? { relationships } : ticket,
  );
  const select = vi.fn();
  render(
    <ContextualRelationships
      ticket={ticket}
      refresh={async () => {}}
      revision={0}
      select={select}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "T-2 Other" }));
  expect(select).toHaveBeenCalledWith("T-2");
  fireEvent.change(screen.getByLabelText("Ticket reference"), {
    target: { value: "T-3" },
  });
  fireEvent.change(screen.getByLabelText("Relationship"), {
    target: { value: "discovered" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add relationship" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "change_contextual_relationship",
      expect.objectContaining({
        source: "T-1",
        target: "T-3",
        kind: "discovered",
        add: true,
      }),
    ),
  );
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TicketDetails } from "./TicketDetails";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
afterEach(cleanup);

test("trashed ticket descriptions remain readable without editing controls", () => {
  const ticket: Ticket = {
    id: "trash",
    reference: "T-2",
    title: "Trashed",
    status: "Todo",
    trashed: true,
    body: "# Archived context\n\n[Reference](https://example.com)\n\n- [ ] Preserved",
    project_id: null,
    effort_id: null,
    availability: null,
    tags: [],
    parent: null,
    children: [],
    prerequisites: [],
  };
  render(
    <TicketDetails
      selected="T-2"
      expanded={false}
      onExpand={vi.fn()}
      onReturn={vi.fn()}
      setSelected={vi.fn()}
      details={{ "T-2": ticket }}
      projects={[]}
      efforts={[]}
      revision={0}
      refresh={vi.fn(async () => {})}
      updateTicket={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Archived context" }),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: "Reference" })).toBeTruthy();
  expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
  expect(
    screen.queryByRole("textbox", { name: "Description rich text" }),
  ).toBeNull();
});

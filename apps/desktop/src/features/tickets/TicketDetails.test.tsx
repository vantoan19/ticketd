// @vitest-environment jsdom
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
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

test("the full-width view marks the reading column and drops the repeated heading", () => {
  const ticket: Ticket = {
    id: "wide",
    reference: "T-3",
    title: "Wide",
    status: "Todo",
    trashed: false,
    body: "Readable",
    project_id: null,
    effort_id: null,
    availability: null,
    tags: [],
    parent: null,
    children: [],
    prerequisites: [],
  };
  const { container } = render(
    <TicketDetails
      selected="T-3"
      expanded
      onExpand={vi.fn()}
      onReturn={vi.fn()}
      setSelected={vi.fn()}
      details={{ "T-3": ticket }}
      projects={[]}
      efforts={[]}
      revision={0}
      refresh={vi.fn(async () => {})}
      updateTicket={vi.fn()}
    />,
  );
  expect(
    container.querySelector(".ticket-detail")?.getAttribute("data-expanded"),
  ).toBe("true");
  expect(screen.queryByText("Ticket details")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Show beside the list" }),
  ).toBeTruthy();
});

test("the mentioned passage is highlighted after following a backlink and cleared on the next navigation", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const base: Ticket = {
    id: "a",
    reference: "T-1",
    title: "Target",
    status: "Todo",
    trashed: false,
    body: "Plain.",
    project_id: null,
    effort_id: null,
    availability: null,
    tags: [],
    parent: null,
    children: [],
    prerequisites: [],
  };
  const source: Ticket = {
    ...base,
    id: "b",
    reference: "T-2",
    title: "Source",
    body: "Intro.\n\nBlocked on T-1 today.",
  };
  vi.mocked(invoke).mockImplementation(async (command: string) =>
    command === "ticket_backlinks"
      ? [
          {
            source_reference: "T-2",
            source_title: "Source",
            note_id: null,
            passage: "Blocked on T-1 today.",
          },
        ]
      : [],
  );
  function Harness() {
    const [selected, setSelected] = useState<string | null>("T-1");
    return (
      <>
        <button type="button" onClick={() => setSelected("T-1")}>
          Open target
        </button>
        <TicketDetails
          selected={selected}
          expanded={false}
          onExpand={vi.fn()}
          onReturn={vi.fn()}
          setSelected={setSelected}
          details={{ "T-1": base, "T-2": source }}
          projects={[]}
          efforts={[]}
          revision={0}
          refresh={vi.fn(async () => {})}
          updateTicket={vi.fn()}
        />
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: /Source/ }));
  await waitFor(() =>
    expect(document.querySelector("[data-mention-target]")?.textContent).toBe(
      "Blocked on T-1 today.",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open target" }));
  await waitFor(() =>
    expect(document.querySelector("[data-mention-target]")).toBeNull(),
  );
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TicketDetails } from "./TicketDetails";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
afterEach(cleanup);

test("relationship navigation replaces the reference and focuses it outside the scrolling document", () => {
  const props = {
    mention: null,
    expanded: false,
    onExpand: vi.fn(),
    onReturn: vi.fn(),
    setSelected: vi.fn(),
    projects: [],
    plans: [],
    revision: 0,
    refresh: vi.fn(async () => {}),
    updateTicket: vi.fn(),
    details: {},
  };
  const { rerender } = render(<TicketDetails {...props} selected="T-KQ39" />);
  const previous = screen.getByRole("heading", { name: "T-KQ39" });
  previous.focus();
  rerender(<TicketDetails {...props} selected="T-KQ21" />);
  const heading = screen.getByRole("heading", { name: "T-KQ21" });
  expect(document.activeElement).toBe(heading);
  expect(heading.closest(".detail-scroll")).toBeNull();
  expect(document.querySelector(".detail-scroll")).toBeTruthy();
});

test("trashed ticket descriptions remain readable without editing controls", () => {
  const ticket: Ticket = {
    id: "trash",
    reference: "T-KQ2",
    title: "Trashed",
    status: "Todo",
    trashed: true,
    body: "# Archived context\n\n[Reference](https://example.com)\n\n- [ ] Preserved",
    project_id: null,
    plan_id: null,
    availability: null,
    tags: [],
    parent: null,
    children: [],
    prerequisites: [],
  };
  render(
    <TicketDetails
      selected="T-KQ2"
      mention={null}
      expanded={false}
      onExpand={vi.fn()}
      onReturn={vi.fn()}
      setSelected={vi.fn()}
      details={{ "T-KQ2": ticket }}
      projects={[]}
      plans={[]}
      revision={0}
      refresh={vi.fn(async () => {})}
      updateTicket={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Archived context" }),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: "Reference" })).toBeTruthy();
  // A read-only checklist box is a drawn glyph, not a disabled control.
  expect(screen.getByRole("img", { name: "Not done" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
  expect(
    screen.queryByRole("textbox", { name: "Description rich text" }),
  ).toBeNull();
  // One notice holds the state and the way back; the header has no Restore.
  const notice = screen.getByText("In Trash. Relationships are kept.");
  expect(
    notice.closest('[data-slot="alert"]')?.querySelector("button")?.textContent,
  ).toBe("Restore");
  const header = document.querySelector(".detail-header") as HTMLElement;
  expect(header.querySelector("button")?.textContent).not.toBe("Restore");
});

test("the full-width view marks the reading column and drops the repeated heading", () => {
  const ticket: Ticket = {
    id: "wide",
    reference: "T-KQ3",
    title: "Wide",
    status: "Todo",
    trashed: false,
    body: "Readable",
    project_id: null,
    plan_id: null,
    availability: null,
    tags: [],
    parent: null,
    children: [],
    prerequisites: [],
  };
  const { container } = render(
    <TicketDetails
      selected="T-KQ3"
      mention={null}
      expanded
      onExpand={vi.fn()}
      onReturn={vi.fn()}
      setSelected={vi.fn()}
      details={{ "T-KQ3": ticket }}
      projects={[]}
      plans={[]}
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

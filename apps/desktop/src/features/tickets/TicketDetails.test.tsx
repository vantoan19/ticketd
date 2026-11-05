// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
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
  const { rerender } = render(<TicketDetails {...props} selected="T-39" />);
  const previous = screen.getByRole("heading", { name: "T-39" });
  previous.focus();
  rerender(<TicketDetails {...props} selected="T-21" />);
  const heading = screen.getByRole("heading", { name: "T-21" });
  expect(document.activeElement).toBe(heading);
  expect(heading.closest(".detail-scroll")).toBeNull();
  expect(document.querySelector(".detail-scroll")).toBeTruthy();
});

test("side by side, the document and the rail are separate bounded scrollers", () => {
  const css = readFileSync("src/styles.css", "utf8");
  const start = css.indexOf(
    "@container ticket-detail (min-width: 652px) {\n  /* Side",
  );
  const block = css.slice(start, css.indexOf("\n}\n", start));
  expect(block).toMatch(/\.detail-scroll \{\s*overflow: hidden;/);
  expect(block).toMatch(/\.detail-content \{\s*height: 100%;\s*min-height: 0;/);
  expect(block).toMatch(
    /\.detail-document,\s*\.detail-content > \.ticket-properties \{\s*min-height: 0;\s*overflow-y: auto;/,
  );
});

test("trashed ticket descriptions remain readable without editing controls", () => {
  const ticket: Ticket = {
    id: "trash",
    reference: "T-2",
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
      selected="T-2"
      mention={null}
      expanded={false}
      onExpand={vi.fn()}
      onReturn={vi.fn()}
      setSelected={vi.fn()}
      details={{ "T-2": ticket }}
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
    plan_id: null,
    availability: null,
    tags: [],
    parent: null,
    children: [],
    prerequisites: [],
  };
  const { container } = render(
    <TicketDetails
      selected="T-3"
      mention={null}
      expanded
      onExpand={vi.fn()}
      onReturn={vi.fn()}
      setSelected={vi.fn()}
      details={{ "T-3": ticket }}
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

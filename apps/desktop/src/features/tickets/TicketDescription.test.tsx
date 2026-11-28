// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  isInaccessible,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TicketDescription } from "./TicketDescription";
import { TicketDetails } from "./TicketDetails";
import type { Ticket } from "@/lib/api/client";
import { TestReads } from "@/lib/workspace-reads/testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function detail(
  body: string,
  id = "description",
  status: Ticket["status"] = "Todo",
) {
  const ticket: Ticket = {
    id,
    reference: "T-FOLD1",
    title: "Description example",
    status,
    trashed: false,
    body,
    project_id: null,
    plan_id: null,
    availability: null,
    tags: [],
    parent: null,
    children: [],
    prerequisites: [],
  };
  return render(
    <TestReads primed={{ ticket }}>
      <TicketDetails
        selected={ticket.reference}
        opened={[ticket.reference]}
        mention={null}
        expanded={false}
        onExpand={vi.fn()}
        onReturn={vi.fn()}
        setSelected={vi.fn()}
        projects={[]}
        plans={[]}
        onMentionReady={vi.fn()}
        onClearMention={vi.fn()}
      />
    </TestReads>,
  );
}

test("the description folds strictly above 2,600 text characters and keeps a heading with its content", () => {
  const threshold = [
    "a".repeat(1090),
    "## Goal",
    "b".repeat(800),
    "c".repeat(706),
  ].join("\n\n");
  const short = detail(threshold);
  expect(screen.getByRole("heading", { name: "Goal" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /more section/ })).toBeNull();
  short.unmount();

  detail(`${threshold}c`);
  expect(isInaccessible(screen.getByText("a".repeat(1090)))).toBe(false);
  expect(screen.queryByRole("heading", { name: "Goal" })).toBeNull();
  const fold = screen.getByRole("button", { name: "1 more section: Goal" });
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("heading", { name: "Goal" })).toBeTruthy();
  expect(isInaccessible(screen.getByText("b".repeat(800)))).toBe(false);
});

const longSpec = [
  "Introduction. ".repeat(72),
  "## Solution",
  "Hidden design. ".repeat(115),
  "## User Stories",
  "Before acceptance contains the search phrase.",
  "## Testing Decisions",
  "The tests refer to [the project](https://example.com/project).",
  "## Migration",
  "Move the data.",
  "## Risks",
  "Keep a copy.",
  "## Acceptance criteria",
  "- [ ] Ready for review",
  "## More information",
  "After acceptance also contains the search phrase.",
].join("\n\n");

test("a long description names the hidden sections, keeps acceptance visible and remembers folds per ticket", () => {
  const referencedSpec =
    longSpec.replace(
      "[the project](https://example.com/project)",
      "[the project][project]",
    ) + "\n\n[project]: https://example.com/project";
  const original = detail(referencedSpec);
  const before =
    "5 more sections: Solution, User Stories, Testing Decisions, +2";
  const after = "1 more section: More information";
  expect(
    screen.getByRole("heading", { name: "Acceptance criteria" }),
  ).toBeTruthy();
  expect(isInaccessible(screen.getByText("Ready for review"))).toBe(false);
  expect(
    screen.getByRole("button", { name: before }).getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    screen.getByRole("button", { name: after }).getAttribute("aria-expanded"),
  ).toBe("false");

  fireEvent.click(screen.getByRole("button", { name: before }));
  expect(
    screen.getByRole("link", { name: "the project" }).getAttribute("href"),
  ).toBe("https://example.com/project");
  original.unmount();

  const another = detail(longSpec, "another-ticket");
  expect(
    screen.getByRole("button", { name: before }).getAttribute("aria-expanded"),
  ).toBe("false");
  another.unmount();

  detail(longSpec);
  expect(
    screen.getByRole("button", { name: before }).getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    screen.getByRole("button", { name: after }).getAttribute("aria-expanded"),
  ).toBe("false");
  expect(screen.getByRole("heading", { name: "User Stories" })).toBeTruthy();
});

test("a headingless description counts its hidden paragraphs", () => {
  detail(
    ["opening ".repeat(110), ...Array(4).fill("paragraph ".repeat(45))].join(
      "\n\n",
    ),
  );
  expect(
    screen.getByRole("button", { name: "4 more paragraphs" }),
  ).toBeTruthy();
});

test("find opens every matching fold and editing shows the full description", async () => {
  const platform = vi
    .spyOn(window.navigator, "platform", "get")
    .mockReturnValue("MacIntel");
  try {
    detail(longSpec);
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const search = screen.getByRole("searchbox", {
      name: "Find in description",
    });
    fireEvent.change(search, { target: { value: "search phrase" } });
    expect(screen.getByRole("heading", { name: "User Stories" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "More information" }),
    ).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("searchbox")).toBeNull();

    fireEvent.keyDown(window, { key: "e" });
    const editor = await screen.findByRole("textbox", {
      name: "Description rich text",
    });
    expect(editor.textContent).toContain(
      "Before acceptance contains the search phrase.",
    );
    expect(screen.queryByRole("button", { name: /more section/ })).toBeNull();
  } finally {
    platform.mockRestore();
  }
});

test("find keeps the query and updates its count and folds when the description changes", () => {
  const platform = vi
    .spyOn(window.navigator, "platform", "get")
    .mockReturnValue("MacIntel");
  try {
    const { rerender } = render(
      <TicketDescription ticketId="refresh" source={longSpec} />,
    );
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const search = screen.getByRole<HTMLInputElement>("searchbox", {
      name: "Find in description",
    });
    fireEvent.change(search, { target: { value: "search phrase" } });
    expect(screen.getByRole("status").textContent).toBe("1 of 2");

    rerender(
      <TicketDescription
        ticketId="refresh"
        source={longSpec.replaceAll("search phrase", "updated text")}
      />,
    );
    expect(search.value).toBe("search phrase");
    expect(screen.getByRole("status").textContent).toBe("No matches");
    expect(screen.queryByRole("heading", { name: "User Stories" })).toBeNull();
  } finally {
    platform.mockRestore();
  }
});

test("the review card's acceptance count returns from Edit to the visible checklist", async () => {
  detail(longSpec, "in-review", "In review");
  const acceptance = screen.getByRole("button", { name: "Acceptance 0 of 1" });
  fireEvent.keyDown(window, { key: "e" });
  const editor = await screen.findByRole("textbox", {
    name: "Description rich text",
  });
  expect(editor.textContent).toContain(
    "Before acceptance contains the search phrase.",
  );
  fireEvent.click(acceptance);
  const checklist = screen.getByRole("heading", {
    name: "Acceptance criteria",
  });
  expect(document.activeElement).toBe(checklist);
  expect(screen.queryByRole("heading", { name: "User Stories" })).toBeNull();
});

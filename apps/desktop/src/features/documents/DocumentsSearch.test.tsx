// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Documents } from "./Documents";
import { documents } from "./api";

vi.mock("./api", () => ({
  documents: {
    currentWork: vi.fn(),
    links: vi.fn().mockResolvedValue([[], []]),
    row: vi.fn().mockResolvedValue({
      id: "d1",
      heading: "",
      plans: [],
      tickets: [],
      tags: [],
    }),
    recent: vi.fn().mockResolvedValue([]),
    trash: vi.fn(),
    pins: vi.fn().mockResolvedValue([]),
    tags: vi.fn().mockResolvedValue([]),
    search: vi.fn(),
    pin: vi.fn(),
    tag: vi.fn(),
    open: vi.fn(),
    show: vi.fn(),
    setTrashed: vi.fn(),
    save: vi.fn(),
  },
}));
vi.mock("@/features/markdown/LazyMarkdownEditor", () => ({
  LazyMarkdownEditor: ({ value }: { value: string }) => <p>{value}</p>,
}));

// The core ranks by relevance, so a body-only match can come before a title match.
const results = [
  {
    id: "body-1",
    heading: "Harness plug-ins live QA",
    snippet: "…records the intermittent attachment preview error during Undo.",
  },
  {
    id: "title-1",
    heading: "Attachment review UI design",
    snippet: "Attachment review UI design",
    updated_at: "2026-11-23T23:43:00.000Z",
  },
  {
    id: "body-2",
    heading: "Fast CI: results",
    snippet: "…the Windows attachment snapshot race, filed as a bug.",
  },
  {
    id: "title-2",
    heading: "Chat attachments spec",
    snippet: "Spec of Chat attachments, written first.",
  },
];

const renderSearch = async (query = "attachment") => {
  render(
    <Documents
      active
      capture={false}
      onCaptureClose={vi.fn()}
      currentTicket={null}
      onOpenTicket={vi.fn()}
      onOpenPlan={vi.fn()}
      target={null}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Search Documents" }),
  );
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search Documents" }),
    { target: { value: query } },
  );
  await screen.findByRole("heading", { name: /^Titles/ });
};

beforeEach(() => {
  localStorage.setItem(
    "ticketd.preferences",
    JSON.stringify({ documentsView: "recent" }),
  );
  vi.mocked(documents.currentWork).mockResolvedValue({
    groups: [],
    finished: 0,
    unlinked: 0,
    trashed: 0,
  });
  vi.mocked(documents.search).mockResolvedValue(results);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("lists title matches first, then the body-only matches, each group with its count", async () => {
  await renderSearch();
  const titles = screen.getByRole("heading", { name: /^Titles/ });
  const inside = screen.getByRole("heading", { name: /^Inside Documents/ });
  expect(titles.textContent).toMatch(/Titles\s*2$/);
  expect(inside.textContent).toMatch(/Inside Documents\s*2$/);
  expect(titles.compareDocumentPosition(inside)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const rows = screen
    .getAllByRole("button")
    .map((button) => button.getAttribute("data-document-row"))
    .filter(Boolean);
  // The relative order the core gave is kept inside a group.
  expect(rows).toEqual(["title-1", "title-2", "body-1", "body-2"]);
});

it("shows the passage under a body-only match and none under a title match", async () => {
  await renderSearch();
  const titles = within(screen.getByRole("region", { name: "Titles" }));
  const inside = within(
    screen.getByRole("region", { name: "Inside Documents" }),
  );
  expect(titles.queryByText(/written first/)).toBeNull();
  expect(
    inside.getByText(/intermittent .*preview error during Undo/).tagName,
  ).toBe("P");
  expect(inside.getByText(/Windows .*snapshot race/)).toBeTruthy();
});

it("marks the query in titles and passages", async () => {
  await renderSearch("Attachment");
  const titles = within(screen.getByRole("region", { name: "Titles" }));
  const first = titles.getByRole("button", {
    name: "Attachment review UI design",
  });
  expect(within(first).getByText("Attachment").tagName).toBe("MARK");
  const second = titles.getByRole("button", { name: "Chat attachments spec" });
  expect(within(second).getByText("attachment").tagName).toBe("MARK");
  const inside = within(
    screen.getByRole("region", { name: "Inside Documents" }),
  );
  const marks = inside.getAllByText("attachment");
  expect(marks.map((mark) => mark.tagName)).toEqual(["MARK", "MARK"]);
});

it("shows the total in the search field and announces the groups", async () => {
  await renderSearch();
  const field = screen
    .getByRole("searchbox", { name: "Search Documents" })
    .closest("[data-slot='search-input']") as HTMLElement;
  expect(within(field).getByText("4")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe(
    "4 results: 2 in titles, 2 inside Documents",
  );
});

it("keeps one roving order down both groups", async () => {
  await renderSearch();
  const row = (id: string) =>
    document.querySelector<HTMLElement>(`[data-document-row="${id}"]`)!;
  expect(row("title-1").tabIndex).toBe(0);
  row("title-1").focus();
  fireEvent.keyDown(row("title-1"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(row("title-2"));
  fireEvent.keyDown(row("title-2"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(row("body-1"));
  fireEvent.keyDown(row("body-1"), { key: "End" });
  expect(document.activeElement).toBe(row("body-2"));
});

it("reads every word of the query: a title holding all of them is a title match", async () => {
  await renderSearch("chat attach");
  const titles = within(screen.getByRole("region", { name: "Titles" }));
  const row = titles.getByRole("button", { name: "Chat attachments spec" });
  expect(
    within(row)
      .getAllByText(/^(chat|attach)$/i)
      .map((mark) => mark.tagName),
  ).toEqual(["MARK", "MARK"]);
  expect(
    titles.queryByRole("button", { name: /Attachment review/ }),
  ).toBeNull();
});

it("leaves out the Titles group when no title matches", async () => {
  vi.mocked(documents.search).mockResolvedValue(
    results.filter((doc) => doc.id.startsWith("body")),
  );
  render(
    <Documents
      active
      capture={false}
      onCaptureClose={vi.fn()}
      currentTicket={null}
      onOpenTicket={vi.fn()}
      onOpenPlan={vi.fn()}
      target={null}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Search Documents" }),
  );
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search Documents" }),
    { target: { value: "attachment" } },
  );
  await screen.findByRole("heading", { name: /^Inside Documents/ });
  expect(screen.queryByRole("heading", { name: /^Titles/ })).toBeNull();
});

it("keeps a search by tag alone as one plain list with no groups or marks", async () => {
  vi.mocked(documents.recent).mockResolvedValue([
    { id: "t1", heading: "Tagged", tags: ["spec"] },
  ]);
  vi.mocked(documents.search).mockResolvedValue([
    { id: "t1", heading: "Tagged", snippet: "Body text", tags: ["spec"] },
  ]);
  render(
    <Documents
      active
      capture={false}
      onCaptureClose={vi.fn()}
      currentTicket={null}
      onOpenTicket={vi.fn()}
      onOpenPlan={vi.fn()}
      target={null}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Show Documents tagged spec" }),
  );
  await screen.findByText("1 result");
  expect(screen.queryByRole("heading", { name: /^Titles/ })).toBeNull();
  expect(
    screen.queryByRole("heading", { name: /^Inside Documents/ }),
  ).toBeNull();
  expect(document.querySelector("mark")).toBeNull();
});

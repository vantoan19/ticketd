// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadPreferences } from "@/lib/preferences";
import { TickingChanges } from "@/test/ticking-changes";
import { Documents } from "./Documents";
import { documents } from "./api";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();
const scrollTo = vi.fn();
Element.prototype.scrollTo = scrollTo as typeof Element.prototype.scrollTo;
vi.mock("@/lib/sync-review-api", () => ({
  syncReview: {
    conflicts: vi.fn(async () => []),
    versions: vi.fn(async () => []),
    version: vi.fn(),
    restore: vi.fn(),
  },
}));
vi.mock("./api", () => ({
  documents: {
    links: vi.fn().mockResolvedValue([[], []]),
    summary: vi.fn(),
    recent: vi.fn(),
    all: vi.fn(),
    byTitle: vi.fn(),
    currentWork: vi.fn(),
    finished: vi.fn(),
    unlinked: vi.fn(),
    trash: vi.fn().mockResolvedValue([]),
    pins: vi.fn().mockResolvedValue([]),
    tags: vi.fn().mockResolvedValue([]),
    search: vi.fn(),
    pin: vi.fn(),
    open: vi.fn(),
    show: vi.fn(),
    version: vi.fn(),
    setTrashed: vi.fn(),
    save: vi.fn(),
  },
}));
vi.mock("@/features/markdown/LazyMarkdownEditor", () => ({
  LazyMarkdownEditor: () => <textarea aria-label="Your thought" />,
}));

const body = [
  "Intro.",
  "## Goals",
  "Text.",
  "## Decisions",
  "### First",
  "### Second",
  "## Rejected",
  "### Why",
  "Text.",
].join("\n\n");
const read = (id: string) => ({
  id,
  title: `Doc ${id}`,
  body,
  created_at: "c",
  updated_at: "u",
  trashed: false,
});
const row = (id: string) => ({ id, heading: `Doc ${id}` });

/** Stores personal choices; the Documents list opens on Recent unless a test says otherwise. */
const choose = (choices: Record<string, string> = {}) =>
  localStorage.setItem(
    "ticketd.preferences",
    JSON.stringify({ documentsView: "recent", ...choices }),
  );
beforeEach(() => {
  localStorage.clear();
  choose();
  vi.mocked(documents.currentWork).mockResolvedValue({
    groups: [],
    finished: 0,
    unlinked: 0,
    trashed: 0,
  });
  vi.mocked(documents.row).mockResolvedValue({
    id: "x",
    heading: "",
    plans: [],
    tickets: [],
    tags: [],
  });
  vi.mocked(documents.pins).mockResolvedValue([]);
  vi.mocked(documents.version).mockResolvedValue(["v", false]);
  vi.mocked(documents.open).mockImplementation(async (id) => read(id));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderDocuments = () =>
  render(
    <TickingChanges>
      <Documents
        active
        capture={false}
        onCaptureClose={vi.fn()}
        currentTicket={null}
        onOpenTicket={vi.fn()}
        onOpenPlan={vi.fn()}
        target={null}
      />
    </TickingChanges>,
  );
const page = (container: HTMLElement) =>
  container.querySelector(".documents-page") as HTMLElement;
const openRow = async (title: string) => {
  fireEvent.click(await screen.findByRole("button", { name: title }));
  await screen.findByRole("button", { name: /Edit/ });
};

it("hides the list while a Document is read at full width and brings it back, remembering the choice", async () => {
  vi.mocked(documents.recent).mockResolvedValue([row("a"), row("b")]);
  const { container, unmount } = renderDocuments();
  await openRow("Doc a");
  expect(page(container).dataset.expanded).toBeUndefined();

  fireEvent.click(screen.getByRole("button", { name: "Read full width" }));
  expect(page(container).dataset.expanded).toBe("true");
  expect(loadPreferences().openDocuments).toBe("expanded");
  expect(screen.queryByRole("button", { name: "Read full width" })).toBeNull();

  // The choice survives a restart: the next Document opens at full width.
  unmount();
  const again = renderDocuments();
  await openRow("Doc b");
  expect(page(again.container).dataset.expanded).toBe("true");

  fireEvent.click(
    screen.getByRole("button", { name: "Show the Documents list" }),
  );
  expect(page(again.container).dataset.expanded).toBeUndefined();
  expect(loadPreferences().openDocuments).toBe("split");
});

it("shows the list as it is when no Document is open, even at full width", async () => {
  choose({ openDocuments: "expanded" });
  vi.mocked(documents.recent).mockResolvedValue([row("a")]);
  const { container } = renderDocuments();
  await screen.findByRole("button", { name: "Doc a" });
  expect(page(container).dataset.reading).toBeUndefined();
  expect(
    screen.queryByRole("button", { name: /Show the Documents list/ }),
  ).toBeNull();
});

const position = () =>
  within(screen.getByRole("group", { name: "Position in the list" }));

it("says where the Document is in the list and steps through it in the list's order, pinned first", async () => {
  choose({ openDocuments: "expanded" });
  vi.mocked(documents.recent).mockResolvedValue([row("a"), row("b"), row("c")]);
  vi.mocked(documents.pins).mockResolvedValue([row("c")]);
  renderDocuments();
  // Pinned Documents come first: c, a, b.
  await openRow("Doc a");
  expect(position().getByText("2 of 3")).toBeTruthy();

  fireEvent.click(position().getByRole("button", { name: "Next Document" }));
  await screen.findByRole("heading", { name: "Doc b" });
  expect(position().getByText("3 of 3")).toBeTruthy();
  expect(
    (
      position().getByRole("button", {
        name: "Next Document",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  fireEvent.click(
    position().getByRole("button", { name: "Previous Document" }),
  );
  await screen.findByRole("heading", { name: "Doc a" });
  fireEvent.click(
    position().getByRole("button", { name: "Previous Document" }),
  );
  await screen.findByRole("heading", { name: "Doc c" });
  expect(position().getByText("1 of 3")).toBeTruthy();
});

it("steps through Current work by its Plan groups, counting a pinned Document once", async () => {
  choose({ openDocuments: "expanded", documentsView: "current" });
  vi.mocked(documents.pins).mockResolvedValue([row("c")]);
  vi.mocked(documents.currentWork).mockResolvedValue({
    groups: [
      {
        plan: { id: "p1", name: "Checkout" },
        documents: [row("a"), row("c")],
      },
      { plan: null, documents: [row("b")] },
    ],
    finished: 0,
    unlinked: 0,
    trashed: 0,
  });
  renderDocuments();
  // The list reads c (pinned), a, c again in its group, then b: three Documents.
  await openRow("Doc a");
  expect(position().getByText("2 of 3")).toBeTruthy();
  fireEvent.click(position().getByRole("button", { name: "Next Document" }));
  await screen.findByRole("heading", { name: "Doc b" });
  expect(position().getByText("3 of 3")).toBeTruthy();
});

it("steps through Recent sorted by title in the sorted order", async () => {
  choose({ openDocuments: "expanded", documentsSort: "title" });
  vi.mocked(documents.recent).mockResolvedValue([row("a"), row("b")]);
  vi.mocked(documents.byTitle).mockResolvedValue([
    row("z"),
    row("y"),
    row("x"),
  ]);
  renderDocuments();
  await openRow("Doc y");
  expect(position().getByText("2 of 3")).toBeTruthy();
  fireEvent.click(position().getByRole("button", { name: "Next Document" }));
  await screen.findByRole("heading", { name: "Doc x" });
});

it("keeps the position slot when the Document is not in the list, so nothing moves", async () => {
  choose({ openDocuments: "expanded" });
  vi.mocked(documents.recent).mockResolvedValue([row("a")]);
  render(
    <TickingChanges>
      <Documents
        active
        capture={false}
        onCaptureClose={vi.fn()}
        currentTicket={null}
        onOpenTicket={vi.fn()}
        onOpenPlan={vi.fn()}
        target={{ id: "elsewhere", key: 1 }}
      />
    </TickingChanges>,
  );
  await screen.findByRole("button", { name: /Edit/ });
  expect(position().getByText("–")).toBeTruthy();
  for (const name of ["Previous Document", "Next Document"])
    expect(
      (position().getByRole("button", { name }) as HTMLButtonElement).disabled,
    ).toBe(true);
});

const expandedAlready = () => choose({ openDocuments: "expanded" });
const outlineNav = () =>
  screen.getByRole("navigation", { name: "On this page, 6 headings" });

it("keeps the ticks and popover beside the list, and swaps them for the rail at full width", async () => {
  vi.mocked(documents.recent).mockResolvedValue([row("a")]);
  const { container } = renderDocuments();
  await openRow("Doc a");
  expect(screen.getByRole("button", { name: "Show outline" })).toBeTruthy();
  expect(container.querySelector(".document-rail")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Read full width" }));
  expect(screen.queryByRole("button", { name: "Show outline" })).toBeNull();
  const rail = container.querySelector(".document-rail") as HTMLElement;
  expect(rail).toBeTruthy();
  // The rail is open without hovering anything: every section, and the current one's subsections.
  expect(
    within(outlineNav())
      .getAllByRole("link")
      .map((link) => link.firstChild?.textContent),
  ).toEqual(["Goals", "Decisions", "Rejected", "Why"]);
  expect(within(rail).getByText("On this page")).toBeTruthy();
});

it("folds and unfolds every section from the rail", async () => {
  expandedAlready();
  vi.mocked(documents.recent).mockResolvedValue([row("a")]);
  renderDocuments();
  await openRow("Doc a");
  fireEvent.click(
    within(outlineNav()).getByRole("button", { name: "Fold all" }),
  );
  expect(
    within(outlineNav()).queryByRole("button", { name: "Fold all" }),
  ).toBeNull();
  fireEvent.click(
    within(outlineNav()).getByRole("button", { name: "Unfold all" }),
  );
  expect(
    within(outlineNav()).getByRole("button", { name: "Fold all" }),
  ).toBeTruthy();
});

it("offers Back to top only once the reader is past the first screen", async () => {
  expandedAlready();
  vi.mocked(documents.recent).mockResolvedValue([row("a")]);
  const { container } = renderDocuments();
  await openRow("Doc a");
  const scroller = container.querySelector(".document-main") as HTMLElement;
  vi.spyOn(scroller, "clientHeight", "get").mockReturnValue(800);
  const scrollTo = (top: number) => {
    scroller.scrollTop = top;
    fireEvent.scroll(scroller);
  };
  expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
  scrollTo(500);
  expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
  scrollTo(1600);
  fireEvent.click(screen.getByRole("button", { name: "Back to top" }));
  expect(scrollTo).toBeDefined();
  expect(vi.mocked(Element.prototype.scrollTo)).toHaveBeenCalledWith(
    expect.objectContaining({ top: 0 }),
  );
  scrollTo(0);
  expect(screen.queryByRole("button", { name: "Back to top" })).toBeNull();
});

it("lists what the Document is linked to in the rail", async () => {
  expandedAlready();
  vi.mocked(documents.recent).mockResolvedValue([row("a")]);
  vi.mocked(documents.row).mockResolvedValue({
    id: "a",
    heading: "Doc a",
    plans: [{ id: "p1", name: "Launch", archived: false, spec: true }],
    tickets: [{ reference: "T-KQ1", title: "Ship it", status: "Todo" }],
    tags: [],
  });
  const { container } = renderDocuments();
  await openRow("Doc a");
  const rail = container.querySelector(".document-rail") as HTMLElement;
  const linked = await within(rail).findByRole("region", { name: "Linked" });
  expect(within(linked).getByText(/Launch/)).toBeTruthy();
  expect(within(linked).getByText(/Ship it/)).toBeTruthy();
});

it("moves focus to the control that takes the place of the one used", async () => {
  vi.mocked(documents.recent).mockResolvedValue([row("a"), row("b")]);
  renderDocuments();
  await openRow("Doc a");
  fireEvent.click(screen.getByRole("button", { name: "Read full width" }));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Show the Documents list" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Show the Documents list" }),
  );
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Read full width" }),
  );
});

it("keeps focus on Next Document after stepping", async () => {
  expandedAlready();
  vi.mocked(documents.recent).mockResolvedValue([row("a"), row("b"), row("c")]);
  renderDocuments();
  await openRow("Doc a");
  fireEvent.click(position().getByRole("button", { name: "Next Document" }));
  await screen.findByRole("heading", { name: "Doc b" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      position().getByRole("button", { name: "Next Document" }),
    ),
  );
});

it("hands focus to Previous Document when stepping reaches the end of the list", async () => {
  expandedAlready();
  vi.mocked(documents.recent).mockResolvedValue([row("a"), row("b")]);
  renderDocuments();
  await openRow("Doc a");
  fireEvent.click(position().getByRole("button", { name: "Next Document" }));
  await screen.findByRole("heading", { name: "Doc b" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      position().getByRole("button", { name: "Previous Document" }),
    ),
  );
});

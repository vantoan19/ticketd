// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor";
import { documents } from "./api";
import { TickingChanges } from "@/test/ticking-changes";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const scrollIntoView = vi.fn();
Element.prototype.scrollIntoView = scrollIntoView;
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
    save: vi.fn(),
    show: vi.fn(),
    version: vi.fn(),
    setTrashed: vi.fn(),
    links: vi.fn().mockResolvedValue([[], []]),
    summary: vi.fn(),
    recent: vi.fn(),
    search: vi.fn(),
  },
}));
vi.mock("@/features/markdown/LazyMarkdownEditor", () => ({
  LazyMarkdownEditor: () => <textarea aria-label="Your thought" />,
}));
const renderEditor = (ui: ReactElement) =>
  render(<TickingChanges>{ui}</TickingChanges>);
beforeEach(() => {
  vi.mocked(documents.links).mockResolvedValue([[], []]);
  vi.mocked(documents.summary).mockResolvedValue({
    id: "d1",
    heading: "",
    plans: [],
    tickets: [],
    tags: [],
  });
});
afterEach(() => {
  cleanup();
  scrollIntoView.mockClear();
  vi.restoreAllMocks();
});

const base = {
  id: "d1",
  title: "Plug-ins",
  created_at: "c",
  updated_at: "u",
  trashed: false,
};
const long = {
  ...base,
  body: [
    "Intro.",
    "## Goals",
    "Text.",
    "## Decisions",
    "### First",
    "### Second",
    "## Rejected",
    "### Why",
    "Text.",
  ].join("\n\n"),
};
/** A link's own words, without the count a section carries. */
const words = (link: HTMLElement) => link.firstChild?.textContent;
const outline = () =>
  screen.getByRole("navigation", { name: "On this page, 6 headings" });

/** jsdom has no layout: place each heading by its text, as if the column were scrolled. */
const tops = {
  Goals: 200,
  Decisions: 900,
  First: 1100,
  Second: 1500,
  Rejected: 2000,
  Why: 2200,
};
function layout() {
  const scroller = document.querySelector(".document-main") as HTMLElement;
  let scrollTop = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = tops[this.textContent as keyof typeof tops];
      const y = this === scroller || top === undefined ? 0 : top - scrollTop;
      return {
        top: y,
        bottom: y,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
      } as DOMRect;
    },
  );
  return (to: number) => {
    scrollTop = to;
    fireEvent.scroll(scroller);
  };
}

it("shows an outline only from three headings", () => {
  renderEditor(
    <DocumentEditor
      initial={{ ...base, body: "## One\n\ntext\n\n## Two\n\ntext" }}
      onClose={vi.fn()}
    />,
  );
  expect(screen.queryByRole("navigation", { name: /On this page/ })).toBeNull();
  cleanup();
  renderEditor(<DocumentEditor initial={long} onClose={vi.fn()} />);
  expect(outline()).toBeTruthy();
});

it("gives each outlined heading an anchor", () => {
  renderEditor(<DocumentEditor initial={long} onClose={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Decisions" }).id).toBe(
    "decisions",
  );
});

it("opens the sections on hover, with the current section's subsections only", () => {
  renderEditor(<DocumentEditor initial={long} onClose={vi.fn()} />);
  layout()(0);
  expect(screen.queryByText("On this page")).toBeNull();
  fireEvent.pointerEnter(outline());
  const list = within(outline());
  expect(list.getByText("On this page")).toBeTruthy();
  expect(list.getAllByRole("link").map(words)).toEqual([
    "Goals",
    "Decisions",
    "Rejected",
  ]);
  fireEvent.pointerLeave(outline());
  expect(screen.queryByText("On this page")).toBeNull();
});

it("scrolls a chosen heading to the top, and instantly under reduced motion", () => {
  renderEditor(<DocumentEditor initial={long} onClose={vi.fn()} />);
  layout()(0);
  fireEvent.pointerEnter(outline());
  fireEvent.click(within(outline()).getByRole("link", { name: /^Rejected/ }));
  expect(scrollIntoView).toHaveBeenLastCalledWith({
    block: "start",
    behavior: "smooth",
  });
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(
    screen.getByRole("heading", { name: "Rejected" }),
  );
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
  } as MediaQueryList);
  fireEvent.click(within(outline()).getByRole("link", { name: /^Rejected/ }));
  expect(scrollIntoView).toHaveBeenLastCalledWith({
    block: "start",
    behavior: "auto",
  });
});

it("follows the scroll: the last heading above the reading line is current", () => {
  renderEditor(<DocumentEditor initial={long} onClose={vi.fn()} />);
  const scrollTo = layout();
  scrollTo(0);
  fireEvent.pointerEnter(outline());
  const current = () =>
    within(outline())
      .getAllByRole("link")
      .map((l) =>
        l.getAttribute("aria-current") === "location" ? words(l) : null,
      )
      .find(Boolean);
  expect(current()).toBe("Goals");
  act(() => scrollTo(1450));
  // Decisions is current, so its subsections show.
  expect(current()).toBe("First");
  expect(within(outline()).getAllByRole("link").map(words)).toEqual([
    "Goals",
    "Decisions",
    "First",
    "Second",
    "Rejected",
  ]);
  act(() => scrollTo(2300));
  expect(current()).toBe("Why");
});

it("marks a chosen section at once and holds the list still while the scroll catches up", () => {
  renderEditor(<DocumentEditor initial={long} onClose={vi.fn()} />);
  const scrollTo = layout();
  scrollTo(0);
  fireEvent.pointerEnter(outline());
  fireEvent.click(within(outline()).getByRole("link", { name: /^Decisions/ }));
  const names = () => within(outline()).getAllByRole("link").map(words);
  expect(names()).toEqual([
    "Goals",
    "Decisions",
    "First",
    "Second",
    "Rejected",
  ]);
  // Passing Goals on the way does not collapse what was chosen.
  act(() => scrollTo(300));
  expect(names()).toEqual([
    "Goals",
    "Decisions",
    "First",
    "Second",
    "Rejected",
  ]);
  // Scrolling by hand lets the list follow the reader again.
  fireEvent.wheel(document.querySelector(".document-main")!);
  act(() => scrollTo(2100));
  expect(names()).toEqual(["Goals", "Decisions", "Rejected", "Why"]);
});

it("works from the keyboard: Tab reaches it, arrows move, Enter goes, Escape closes", () => {
  renderEditor(<DocumentEditor initial={long} onClose={vi.fn()} />);
  layout()(0);
  const ticks = within(outline()).getByRole("button", {
    name: "Show outline",
  });
  act(() => ticks.focus());
  const links = within(outline()).getAllByRole("link");
  expect(links).toHaveLength(3);
  fireEvent.keyDown(ticks, { key: "ArrowDown" });
  expect(document.activeElement).toBe(links[0]);
  fireEvent.keyDown(links[0]!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(links[1]);
  fireEvent.keyDown(links[1]!, { key: "End" });
  expect(document.activeElement).toBe(links[2]);
  fireEvent.keyDown(links[2]!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(links[1]);
  fireEvent.click(links[1]!);
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(
    screen.getByRole("heading", { name: "Decisions" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByText("On this page")).toBeNull();
  expect(document.activeElement).toBe(
    within(outline()).getByRole("button", { name: "Show outline" }),
  );
});

it("does not outline while editing", () => {
  renderEditor(<DocumentEditor initial={long} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.queryByRole("navigation", { name: /On this page/ })).toBeNull();
});

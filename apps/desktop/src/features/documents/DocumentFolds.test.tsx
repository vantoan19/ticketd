// @vitest-environment jsdom
import {
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
    row: vi.fn(),
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
  localStorage.clear();
  vi.mocked(documents.links).mockResolvedValue([[], []]);
  vi.mocked(documents.row).mockResolvedValue({
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

const document1 = {
  id: "d1",
  title: "Log",
  created_at: "c",
  updated_at: "u",
  trashed: false,
  body: [
    "Intro. Then more.",
    "## Decisions",
    "We chose Rust. It is fast.",
    "### First",
    "First text. More of it.",
    "### Second",
    "Second text. More of it.",
    "## Rejected",
    "Nothing was rejected. Not one.",
  ].join("\n\n"),
};
const open = (id = "d1") =>
  renderEditor(
    <DocumentEditor initial={{ ...document1, id }} onClose={vi.fn()} />,
  );
const chevron = (heading: string) =>
  screen.getByRole("button", { name: `Fold ${heading}` });
/** Whether the text can be seen: not inside anything the Document hid. */
const visible = (text: string) => {
  const element = screen.queryByText(text);
  return element !== null && element.closest("[hidden]") === null;
};

it("folds a section up to the next heading of its level and unfolds it again", () => {
  open();
  expect(chevron("Decisions").getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(chevron("Decisions"));
  expect(chevron("Decisions").getAttribute("aria-expanded")).toBe("false");
  // The section, subsections included, steps aside; the next section stays.
  expect(visible("We chose Rust. It is fast.")).toBe(false);
  expect(visible("First text. More of it.")).toBe(false);
  expect(visible("Second text. More of it.")).toBe(false);
  expect(visible("Nothing was rejected. Not one.")).toBe(true);
  expect(visible("Intro. Then more.")).toBe(true);
  fireEvent.click(chevron("Decisions"));
  expect(visible("We chose Rust. It is fast.")).toBe(true);
  expect(visible("Second text. More of it.")).toBe(true);
});

it("folds a subsection only up to the next subsection", () => {
  open();
  fireEvent.click(chevron("First"));
  expect(visible("First text. More of it.")).toBe(false);
  expect(visible("Second text. More of it.")).toBe(true);
  expect(visible("We chose Rust. It is fast.")).toBe(true);
});

it("shows a folded heading with its first sentence beside it", () => {
  open();
  expect(screen.queryByText("We chose Rust.")).toBeNull();
  fireEvent.click(chevron("Decisions"));
  const heading = screen.getByRole("heading", { name: "Decisions" });
  expect(within(heading).getByText("We chose Rust.")).toBeTruthy();
});

/** jsdom has no layout: the reader is at the top, with every heading below the reading line. */
function atTheTop() {
  const tops: Record<string, number> = {
    decisions: 200,
    first: 300,
    second: 400,
    rejected: 500,
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = tops[this.id] ?? 0;
      return {
        top,
        bottom: top,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
      } as DOMRect;
    },
  );
}
const outline = () => screen.getByRole("navigation", { name: /On this page/ });
const inOutline = () => {
  fireEvent.pointerEnter(outline());
  return within(outline());
};

it("folds every section down to its first sentence from the outline, and unfolds them all", () => {
  open();
  fireEvent.click(inOutline().getByRole("button", { name: "Fold all" }));
  // Every section is its heading and first sentence, Decisions too: its own text folds to its
  // first sentence and its subsections stay on show, each folded.
  expect(visible("We chose Rust. It is fast.")).toBe(false);
  expect(visible("First text. More of it.")).toBe(false);
  expect(visible("Second text. More of it.")).toBe(false);
  expect(visible("Nothing was rejected. Not one.")).toBe(false);
  const lines = screen
    .getAllByRole("heading", { level: 2 })
    .concat(screen.getAllByRole("heading", { level: 3 }));
  expect(lines.every((line) => line.closest("[hidden]") === null)).toBe(true);
  expect(lines.map((line) => line.textContent)).toEqual([
    "DecisionsWe chose Rust.",
    "RejectedNothing was rejected.",
    "FirstFirst text.",
    "SecondSecond text.",
  ]);
  const menu = inOutline();
  expect(menu.queryByRole("button", { name: "Fold all" })).toBeNull();
  fireEvent.click(menu.getByRole("button", { name: "Unfold all" }));
  expect(visible("We chose Rust. It is fast.")).toBe(true);
  expect(visible("First text. More of it.")).toBe(true);
  expect(visible("Nothing was rejected. Not one.")).toBe(true);
  expect(
    within(screen.getByRole("heading", { name: "Decisions" })).queryByText(
      "We chose Rust.",
    ),
  ).toBeNull();
  expect(inOutline().queryByRole("button", { name: "Unfold all" })).toBeNull();
});

it("draws the chevron open where subsections show, and closed where a section is folded away", () => {
  open();
  const points = (heading: string) =>
    chevron(heading).querySelector("svg")?.getAttribute("class") ?? "";
  expect(points("Decisions")).toContain("lucide-chevron-down");
  fireEvent.click(inOutline().getByRole("button", { name: "Fold all" }));
  // Decisions shows its first sentence and its subsections: it still reads as open.
  expect(points("Decisions")).toContain("lucide-chevron-down");
  expect(points("First")).toContain("lucide-chevron-right");
  expect(points("Rejected")).toContain("lucide-chevron-right");
  fireEvent.click(chevron("Decisions"));
  expect(points("Decisions")).toContain("lucide-chevron-down");
  fireEvent.click(chevron("Rejected"));
  expect(points("Rejected")).toContain("lucide-chevron-down");
});

it("keeps Fold all after a reload, and opening a section brings back its text before its subsections", () => {
  const { unmount } = open();
  fireEvent.click(inOutline().getByRole("button", { name: "Fold all" }));
  unmount();
  open();
  expect(visible("We chose Rust. It is fast.")).toBe(false);
  expect(visible("First text. More of it.")).toBe(false);
  expect(chevron("Decisions").getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(chevron("Decisions"));
  expect(chevron("Decisions").getAttribute("aria-expanded")).toBe("true");
  expect(visible("We chose Rust. It is fast.")).toBe(true);
  expect(visible("First text. More of it.")).toBe(false);
});

it("keeps folded headings in the outline and unfolds one that is chosen there", () => {
  open();
  atTheTop();
  fireEvent.click(chevron("Rejected"));
  expect(inOutline().getByRole("link", { name: /^Rejected/ })).toBeTruthy();
  fireEvent.click(inOutline().getByRole("link", { name: /^Rejected/ }));
  expect(chevron("Rejected").getAttribute("aria-expanded")).toBe("true");
  expect(visible("Nothing was rejected. Not one.")).toBe(true);
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(
    screen.getByRole("heading", { name: "Rejected" }),
  );
});

it("unfolds the sections around a subsection chosen in the outline", () => {
  open();
  atTheTop();
  fireEvent.click(chevron("Decisions"));
  fireEvent.click(inOutline().getByRole("link", { name: /^Second/ }));
  expect(visible("Second text. More of it.")).toBe(true);
  expect(chevron("Decisions").getAttribute("aria-expanded")).toBe("true");
});

it("remembers folds for the Document on this computer", () => {
  const { unmount } = open();
  fireEvent.click(chevron("Rejected"));
  unmount();
  open();
  expect(chevron("Rejected").getAttribute("aria-expanded")).toBe("false");
  expect(visible("Nothing was rejected. Not one.")).toBe(false);
  cleanup();
  // Another Document has its own folds.
  open("d2");
  expect(chevron("Rejected").getAttribute("aria-expanded")).toBe("true");
});

it("shows everything while editing and folds again on leaving Edit", () => {
  open();
  fireEvent.click(chevron("Rejected"));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.queryByRole("button", { name: "Fold Rejected" })).toBeNull();
  expect(screen.getByLabelText("Your thought")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
  expect(chevron("Rejected").getAttribute("aria-expanded")).toBe("false");
});

it("never changes the Markdown", () => {
  open();
  fireEvent.click(chevron("Rejected"));
  expect(documents.save).not.toHaveBeenCalled();
});

it("ignores a stored fold for a heading that is gone", () => {
  localStorage.setItem("ticketd.document-folds.d1", '["gone","rejected"]');
  open();
  expect(chevron("Rejected").getAttribute("aria-expanded")).toBe("false");
  expect(chevron("Decisions").getAttribute("aria-expanded")).toBe("true");
});

it("does not fold headings above the sections or deeper than subsections", () => {
  renderEditor(
    <DocumentEditor
      initial={{
        ...document1,
        body: "# Top\n\n## A\n\ntext\n\n#### Deep\n\n## B\n\n## C",
      }}
      onClose={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "Fold Top" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Fold Deep" })).toBeNull();
  expect(chevron("A")).toBeTruthy();
});

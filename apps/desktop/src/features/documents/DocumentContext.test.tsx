// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor";
import { documents, type DocumentSummary } from "./api";
import { TickingChanges } from "@/test/ticking-changes";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
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
    links: vi.fn(),
    row: vi.fn(),
    tag: vi.fn(),
    createTicket: vi.fn(),
    recent: vi.fn(),
    search: vi.fn(),
  },
}));
const renderEditor = (ui: ReactElement) =>
  render(<TickingChanges>{ui}</TickingChanges>);

const stored = {
  id: "d1",
  title: "Checkout spec",
  body: "Some words to read.",
  created_at: "2026-11-01T09:00:00Z",
  updated_at: new Date().toISOString(),
  trashed: false,
};
const plan = (name: string, archived = false, spec = false) => ({
  id: `plan-${name}`,
  name,
  archived,
  spec,
});
const ticket = (reference: string, status = "In progress") => ({
  reference,
  title: `Work on ${reference}`,
  status,
});
const row = (
  context: Partial<Pick<DocumentSummary, "plans" | "tickets" | "tags">> = {},
): DocumentSummary => ({
  id: "d1",
  heading: "Checkout spec",
  plans: [],
  tickets: [],
  tags: [],
  ...context,
});
const mention = (reference: string, passage: string) => ({
  source_id: `t-${reference}`,
  target_id: "d1",
  source_kind: "ticket",
  target_kind: "document",
  source_label: reference,
  target_label: "Checkout spec",
  source_trashed: false,
  target_trashed: false,
  passage,
});
const meta = () => document.querySelector(".document-meta");
const openMenu = () =>
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Document actions" }),
    { button: 0, ctrlKey: false },
  );

beforeEach(() => {
  vi.mocked(documents.links).mockResolvedValue([[], []]);
  vi.mocked(documents.row).mockResolvedValue(row());
  vi.mocked(documents.tag).mockResolvedValue(undefined);
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.version).mockResolvedValue([stored.updated_at, false]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("says Spec of the Plan under the title when the Document is the spec of an Archived Plan", async () => {
  vi.mocked(documents.row).mockResolvedValue(
    row({ plans: [plan("Old launch", true, true)] }),
  );
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  const open = await screen.findByRole("button", {
    name: "Spec of Old launch",
  });
  expect(meta()?.contains(open)).toBe(true);
  // The Plan is listed again under Linked, with its role, and says it is Archived.
  const linked = screen.getByRole("region", { name: "Linked" });
  expect(linked.textContent).toMatch(/Old launch\s*·\s*spec\s*·\s*archived/);
});

it("names an Archived Plan in the breadcrumb, from the row, as it does an Active one", async () => {
  vi.mocked(documents.row).mockResolvedValue(
    row({ plans: [plan("Old launch", true, true)] }),
  );
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  const crumb = await screen.findByRole("button", {
    name: "Open Plan Old launch",
  });
  expect(crumb.closest(".document-bar")).not.toBeNull();
});

it("shows the first ticket as its status and reference, and +1 for a second", async () => {
  vi.mocked(documents.row).mockResolvedValue(
    row({ tickets: [ticket("T-KQ1", "Done"), ticket("T-KQ2")] }),
  );
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  const first = await screen.findByRole("button", { name: "Open T-KQ1" });
  expect(meta()?.contains(first)).toBe(true);
  expect(within(meta() as HTMLElement).getByRole("img", { name: "Done" }));
  expect(meta()?.textContent).toContain("T-KQ1+1");
  expect(meta()?.textContent).not.toContain("T-KQ2");
});

it("says so when the Document's context cannot be read, instead of showing none", async () => {
  vi.mocked(documents.row).mockRejectedValue(new Error("disk unavailable"));
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("load the connections");
});

it("keeps only the time, reading time and storage state for a Document with no links", async () => {
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  await waitFor(() => expect(documents.row).toHaveBeenCalledWith("d1"));
  expect(meta()?.textContent).toMatch(
    /^Updated \S+.*·\s*1 min read\s*·\s*Saved on this computer$/,
  );
  expect(screen.queryByText(/Spec of/)).toBeNull();
  expect(screen.queryByRole("region", { name: "Linked" })).toBeNull();
  expect(screen.queryByText(/Mentioned in/)).toBeNull();
});

it("counts the minutes to read from the words, 230 a minute", async () => {
  const words = Array.from({ length: 1000 }, () => "word").join(" ");
  renderEditor(
    <DocumentEditor initial={{ ...stored, body: words }} onClose={vi.fn()} />,
  );
  expect(meta()?.textContent).toContain("4 min read");
});

it("follows the meta line with the tags as chips and removes one", async () => {
  vi.mocked(documents.row).mockResolvedValue(
    row({ tags: ["checkout", "design"] }),
  );
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  const tags = await screen.findByRole("list", { name: "Tags" });
  expect(meta()?.contains(tags)).toBe(true);
  expect(within(tags).getAllByRole("listitem")).toHaveLength(2);
  vi.mocked(documents.row).mockResolvedValue(row({ tags: ["design"] }));
  fireEvent.click(screen.getByRole("button", { name: "Remove tag checkout" }));
  await waitFor(() =>
    expect(documents.tag).toHaveBeenCalledWith("d1", "checkout", false),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Remove tag checkout" })).toBe(
      null,
    ),
  );
});

it("ends with Linked and one closed Mentioned in line that lists each mention with its passage", async () => {
  vi.mocked(documents.row).mockResolvedValue(
    row({ plans: [plan("Checkout", false, true)], tickets: [ticket("T-KQ1")] }),
  );
  vi.mocked(documents.links).mockResolvedValue([
    [],
    [
      mention("T-KQ1", "See the checkout flow."),
      mention("T-KQ2", "Blocked on this spec."),
      {
        ...mention("d9", "Builds on this."),
        source_kind: "document",
        source_label: "Research",
      },
    ],
  ]);
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  const linked = await screen.findByRole("region", { name: "Linked" });
  expect(within(linked).getByRole("button", { name: /Checkout/ })).toBeTruthy();
  expect(within(linked).getByRole("button", { name: /T-KQ1/ })).toBeTruthy();
  const toggle = await screen.findByRole("button", {
    name: "Mentioned in 2 tickets and 1 Document",
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText(/Blocked on this spec/)).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(await screen.findByText(/Blocked on this spec/)).toBeTruthy();
  const mentions = screen.getByRole("region", { name: "Mentions" });
  expect(within(mentions).getByText(/See the checkout flow/)).toBeTruthy();
  expect(within(mentions).getByText(/Builds on this/)).toBeTruthy();
  expect(
    within(mentions).getAllByRole("button", { name: /T-KQ|Research/ }),
  ).toHaveLength(3);
  // Each passage is a row of its own that names its source, so passages never run together.
  const rows = within(mentions)
    .getAllByText(/^From /)
    .map((label) => label.closest("li")?.textContent ?? "");
  expect(rows).toHaveLength(3);
  // In reference order: the Document, then the tickets.
  expect(rows[0]).toMatch(/^From Research\s*Builds on this\./);
  expect(rows[1]).toMatch(/^From T-KQ1\s*See the checkout flow\./);
});

it("leaves nothing of the old block under the text", async () => {
  vi.mocked(documents.row).mockResolvedValue(
    row({ plans: [plan("Checkout")], tags: ["a"] }),
  );
  renderEditor(
    <DocumentEditor initial={stored} onClose={vi.fn()} onOpenGraph={vi.fn()} />,
  );
  await screen.findByRole("region", { name: "Linked" });
  for (const name of [
    "Link a Document",
    "Create ticket from this",
    "Open graph",
    "Add tags",
  ])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByText("Visibility")).toBeNull();
  expect(screen.queryByText(/Supporting Document of/)).toBeNull();
});

it("reaches every action from the … menu, Details first and Move to Trash last", async () => {
  renderEditor(
    <DocumentEditor initial={stored} onClose={vi.fn()} onOpenGraph={vi.fn()} />,
  );
  openMenu();
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "Details",
    "Add tags…",
    "Link a Document…",
    "Create ticket from this",
    "Open in graph",
    "History…",
    "Export Markdown with files…",
    "Move to Trash",
  ]);
});

it("shows the dates, visibility and supporting Plans in Details", async () => {
  vi.mocked(documents.row).mockResolvedValue(
    row({ plans: [plan("Checkout revamp"), plan("Old launch", true, true)] }),
  );
  renderEditor(
    <DocumentEditor
      initial={{ ...stored, updated_at: "2026-11-02T10:00:00Z" }}
      onClose={vi.fn()}
    />,
  );
  await screen.findByRole("region", { name: "Linked" });
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Details" }));
  const details = await screen.findByRole("dialog", { name: "Details" });
  const text = details.textContent ?? "";
  expect(text).toContain("Created");
  expect(text).toContain("Updated");
  expect(text).toContain("Shown in Documents");
  expect(text).toMatch(/Supporting Document of\s*Checkout revamp/);
  expect(text).not.toContain("Old launch");
});

it("adds a tag from the menu", async () => {
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Add tags…" }));
  fireEvent.change(await screen.findByLabelText("Add tag"), {
    target: { value: "design" },
  });
  vi.mocked(documents.row).mockResolvedValue(row({ tags: ["design"] }));
  fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
  await waitFor(() =>
    expect(documents.tag).toHaveBeenCalledWith("d1", "design", true),
  );
  expect(await screen.findByRole("list", { name: "Tags" })).toBeTruthy();
});

it("creates a ticket from the menu with the heading as its title, and opens it", async () => {
  vi.mocked(documents.createTicket).mockResolvedValue({ reference: "T-KQ9" });
  const open = vi.fn();
  renderEditor(
    <DocumentEditor initial={stored} onClose={vi.fn()} onOpenTicket={open} />,
  );
  openMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Create ticket from this" }),
  );
  expect(await screen.findByLabelText("New ticket title")).toHaveProperty(
    "value",
    "Checkout spec",
  );
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("T-KQ9"));
});

it("opens the graph from the menu", async () => {
  const graph = vi.fn();
  renderEditor(
    <DocumentEditor initial={stored} onClose={vi.fn()} onOpenGraph={graph} />,
  );
  openMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Open in graph" }),
  );
  await waitFor(() => expect(graph).toHaveBeenCalledWith("d1"));
});

const reading = (expanded: boolean) => ({
  expanded,
  onExpandedChange: vi.fn(),
  place: null,
  previous: null,
  next: null,
  focus: null,
  onFocused: vi.fn(),
  onStep: vi.fn(),
});

it("draws the breadcrumb slash only after a crumb: not alone at full width without a Plan", async () => {
  const bar = () => document.querySelector(".document-bar");
  renderEditor(
    <DocumentEditor
      initial={stored}
      reading={reading(true)}
      onClose={vi.fn()}
    />,
  );
  await screen.findByRole("heading", { name: "Checkout spec" });
  // Full width, no Plan: only the list's button stands before the title.
  expect(bar()?.querySelector(".document-crumb-sep")).toBeNull();
  cleanup();
  // Beside the list, "Documents / title".
  renderEditor(
    <DocumentEditor
      initial={stored}
      reading={reading(false)}
      onClose={vi.fn()}
    />,
  );
  await screen.findByRole("heading", { name: "Checkout spec" });
  expect(bar()?.querySelector(".document-crumb-sep")).not.toBeNull();
  cleanup();
  // Full width with a Plan: the Plan is the crumb before it.
  vi.mocked(documents.row).mockResolvedValue(
    row({ plans: [plan("Launch", false, true)] }),
  );
  renderEditor(
    <DocumentEditor
      initial={stored}
      reading={reading(true)}
      onClose={vi.fn()}
    />,
  );
  await screen.findByRole("button", { name: "Open Plan Launch" });
  expect(bar()?.querySelector(".document-crumb-sep")).not.toBeNull();
});

it("gives Move to Trash its icon, so its label lines up with the other menu items", async () => {
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  openMenu();
  const trash = await screen.findByRole("menuitem", { name: "Move to Trash" });
  expect(trash.querySelector("svg")).not.toBeNull();
  const details = screen.getByRole("menuitem", { name: "Details" });
  expect(details.querySelector("svg")).not.toBeNull();
});

it("edits the title in a field that wraps, and Enter leaves it without adding a line", async () => {
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const title = (await screen.findByRole("textbox", {
    name: "Title",
  })) as HTMLTextAreaElement;
  expect(title.tagName).toBe("TEXTAREA");
  fireEvent.change(title, { target: { value: "A long title\nin two lines" } });
  expect(title.value).toBe("A long title in two lines");
  expect(title.closest(".document-title")?.getAttribute("data-value")).toBe(
    "A long title in two lines",
  );
  const enter = fireEvent.keyDown(title, { key: "Enter" });
  expect(enter).toBe(false);
});

it("ignores a row read that answers after a newer one, so old tags do not come back", async () => {
  vi.mocked(documents.row).mockResolvedValue(
    row({ tags: ["checkout", "design", "launch"] }),
  );
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  const tags = await screen.findByRole("list", { name: "Tags" });
  expect(within(tags).getAllByRole("listitem")).toHaveLength(3);
  // The first edit's read is slow; the second edit's read answers first.
  let slow!: (value: DocumentSummary) => void;
  vi.mocked(documents.row).mockImplementationOnce(
    () => new Promise<DocumentSummary>((resolve) => (slow = resolve)),
  );
  vi.mocked(documents.row).mockResolvedValue(row({ tags: ["launch"] }));
  fireEvent.click(screen.getByRole("button", { name: "Remove tag checkout" }));
  await waitFor(() => expect(documents.row).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Remove tag design" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Remove tag design" })).toBe(
      null,
    ),
  );
  slow(row({ tags: ["design", "launch"] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("button", { name: "Remove tag design" })).toBe(
    null,
  );
  expect(
    screen.getByRole("button", { name: "Remove tag launch" }),
  ).toBeTruthy();
});

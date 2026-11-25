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
    summary: vi.fn(),
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
  vi.mocked(documents.summary).mockResolvedValue(row());
  vi.mocked(documents.tag).mockResolvedValue(undefined);
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.version).mockResolvedValue([stored.updated_at, false]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("says Spec of the Plan under the title when the Document is the spec of an Archived Plan", async () => {
  vi.mocked(documents.summary).mockResolvedValue(
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

it("shows the first ticket as its status and reference, and +1 for a second", async () => {
  vi.mocked(documents.summary).mockResolvedValue(
    row({ tickets: [ticket("T-KQ1", "Done"), ticket("T-KQ2")] }),
  );
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  const first = await screen.findByRole("button", { name: "Open T-KQ1" });
  expect(meta()?.contains(first)).toBe(true);
  expect(within(meta() as HTMLElement).getByRole("img", { name: "Done" }));
  expect(meta()?.textContent).toContain("T-KQ1+1");
  expect(meta()?.textContent).not.toContain("T-KQ2");
});

it("keeps only the time, reading time and storage state for a Document with no links", async () => {
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  await waitFor(() => expect(documents.summary).toHaveBeenCalledWith("d1"));
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
  vi.mocked(documents.summary).mockResolvedValue(
    row({ tags: ["checkout", "design"] }),
  );
  renderEditor(<DocumentEditor initial={stored} onClose={vi.fn()} />);
  const tags = await screen.findByRole("list", { name: "Tags" });
  expect(meta()?.contains(tags)).toBe(true);
  expect(within(tags).getAllByRole("listitem")).toHaveLength(2);
  vi.mocked(documents.summary).mockResolvedValue(row({ tags: ["design"] }));
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
  vi.mocked(documents.summary).mockResolvedValue(
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
});

it("leaves nothing of the old block under the text", async () => {
  vi.mocked(documents.summary).mockResolvedValue(
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
  vi.mocked(documents.summary).mockResolvedValue(
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
  vi.mocked(documents.summary).mockResolvedValue(row({ tags: ["design"] }));
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

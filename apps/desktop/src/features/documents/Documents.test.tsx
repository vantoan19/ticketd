// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Documents } from "./Documents";
import { documents } from "./api";

vi.mock("./api", () => ({
  documents: {
    links: vi.fn().mockResolvedValue([[], []]),
    recent: vi.fn(),
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
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("moves a Document to Trash and restores it from Trash navigation", async () => {
  const doc = {
    id: "d1",
    title: "Context",
    body: "Preserved",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  };
  let trashed = false;
  vi.mocked(documents.recent).mockImplementation(async () =>
    trashed ? [] : [{ id: doc.id, heading: doc.title }],
  );
  vi.mocked(documents.trash).mockImplementation(async () =>
    trashed ? [{ id: doc.id, heading: doc.title }] : [],
  );
  vi.mocked(documents.open).mockImplementation(async () => ({
    ...doc,
    trashed,
  }));
  vi.mocked(documents.setTrashed).mockImplementation(async (_id, value) => {
    trashed = value;
    return { ...doc, trashed };
  });
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
  fireEvent.click(await screen.findByRole("button", { name: "Context" }));
  fireEvent.pointerDown(
    await screen.findByRole("button", { name: "Document actions" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Move to Trash" }),
  );
  await screen.findByText("In Trash");
  fireEvent.click(screen.getByRole("button", { name: "Back to Documents" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Context" })).toBeNull(),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Trash" }));
  fireEvent.click(await screen.findByRole("button", { name: "Context" }));
  expect(await screen.findByText("Preserved")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByRole("button", { name: "Document actions" });
});

it("arranges its own entrance: the header, then the toolbar, then the list, a stagger step apart", async () => {
  vi.mocked(documents.recent).mockResolvedValue([
    { id: "d1", heading: "Context" },
  ]);
  const { container } = render(
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
  await screen.findByRole("button", { name: "Context" });
  expect(
    container
      .querySelector(".documents-page")
      ?.hasAttribute("data-own-entrance"),
  ).toBe(true);
  const steps = [...container.querySelectorAll<HTMLElement>("[data-enter]")];
  expect(
    steps.map((step) => step.style.getPropertyValue("--enter-step")),
  ).toEqual(["0", "1", "2"]);
  // The header keeps its place at the top of the scrolling list.
  expect(steps[0]?.className).toBe("documents-list-head");
  expect(steps[0]?.querySelector('[data-slot="pane-header"]')).not.toBeNull();
  expect(steps[1]?.className).toBe("documents-toolbar");
  expect(steps[2]?.textContent).toContain("Context");
});

it("searches and opens a result using keyboard accessible controls", async () => {
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.trash).mockResolvedValue([]);
  vi.mocked(documents.search).mockResolvedValue([
    { id: "1", heading: "Compass", snippet: "a compass" },
  ]);
  vi.mocked(documents.open).mockResolvedValue({
    id: "1",
    title: "Compass",
    body: "a compass",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  });
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
  fireEvent.click(screen.getByRole("button", { name: "Search Documents" }));
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search Documents" }),
    {
      target: { value: "compass" },
    },
  );
  const result = await screen.findByRole("button", { name: "Compass" });
  result.focus();
  expect(document.activeElement).toBe(result);
  fireEvent.click(result);
  await waitFor(() => expect(documents.open).toHaveBeenCalledWith("1"));
});

it("offers a clear way back from an empty Document search", async () => {
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.search).mockResolvedValue([]);
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
  fireEvent.click(screen.getByRole("button", { name: "Search Documents" }));
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search Documents" }),
    {
      target: { value: "missing" },
    },
  );
  await screen.findByText(/No Documents match .missing./);
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(
    (screen.getByLabelText("Search Documents") as HTMLInputElement).value,
  ).toBe("");
  expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
});

it("shows snippet, tags and date per row, highlights matches and refocuses search on Clear", async () => {
  vi.mocked(documents.recent).mockResolvedValue([
    {
      id: "1",
      heading: "Plan",
      snippet: "First plan text",
      tags: ["spec"],
      updated_at: new Date().toISOString(),
    },
  ]);
  vi.mocked(documents.search).mockResolvedValue([
    { id: "1", heading: "Plan", snippet: "First plan text", tags: ["spec"] },
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
  // A row is the title and one meta line; the snippet shows in search results.
  const time = await screen.findByText(
    new Date().toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }),
  );
  expect(time.tagName).toBe("TIME");
  expect(screen.queryByText("First plan text")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Search Documents" }));
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search Documents" }),
    {
      target: { value: "plan" },
    },
  );
  await screen.findByText("1 result");
  expect(document.querySelector("mark")?.textContent).toBe("plan");
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(document.activeElement).toBe(
    screen.getByLabelText("Search Documents"),
  );
});

it("disables tagging and ticket creation for a trashed Document", async () => {
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.open).mockResolvedValue({
    id: "1",
    title: "Old",
    body: "x",
    created_at: "now",
    updated_at: "now",
    trashed: true,
  });
  render(
    <Documents
      active
      capture={false}
      onCaptureClose={vi.fn()}
      currentTicket={null}
      onOpenTicket={vi.fn()}
      onOpenPlan={vi.fn()}
      target={{ id: "1", key: 1 }}
    />,
  );
  await screen.findByText("In Trash");
  expect(
    (screen.getByRole("button", { name: "Add tags" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Create ticket from this",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("offers Browse Documents from an empty Trash", async () => {
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.trash).mockResolvedValue([]);
  (documents as unknown as { all: ReturnType<typeof vi.fn> }).all = vi
    .fn()
    .mockResolvedValue([]);
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
  fireEvent.click(screen.getByRole("radio", { name: "Trash" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Browse Documents" }),
  );
  expect(
    screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked"),
  ).toBe("true");
});

it("an empty Documents list offers New Document once, in its header", async () => {
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.trash).mockResolvedValue([]);
  const onCapture = vi.fn();
  render(
    <Documents
      active
      capture={false}
      onCapture={onCapture}
      onCaptureClose={vi.fn()}
      currentTicket={null}
      onOpenTicket={vi.fn()}
      onOpenPlan={vi.fn()}
      target={null}
    />,
  );
  await screen.findByText("No recently opened Documents");
  // The header holds New Document, so the empty state adds no second button (P9).
  const create = screen.getAllByRole("button", { name: "New Document" });
  expect(create).toHaveLength(1);
  fireEvent.click(create[0]!);
  expect(onCapture).toHaveBeenCalled();
});

const renderDocuments = () =>
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

it("says on each row where the Document belongs and never asks for links per row", async () => {
  const plan = (name: string, archived = false, spec = false) => ({
    name,
    archived,
    spec,
  });
  const ticket = (reference: string) => ({
    reference,
    title: "Work",
    status: "Todo",
  });
  vi.mocked(documents.recent).mockResolvedValue([
    { id: "a", heading: "Spec doc", plans: [plan("Launch", false, true)] },
    {
      id: "b",
      heading: "Old notes",
      plans: [plan("Old launch", true)],
      tickets: [ticket("T-KQ1")],
    },
    { id: "c", heading: "Brief", tickets: [ticket("T-KQ2"), ticket("T-KQ3")] },
    {
      id: "d",
      heading: "T-KQ4 findings",
      tickets: [ticket("T-KQ4")],
    },
    { id: "e", heading: "Loose", plans: [], tickets: [] },
  ]);
  const { container } = renderDocuments();
  await screen.findByRole("button", { name: "Spec doc" });
  const meta = (title: string) =>
    screen
      .getByRole("button", { name: title })
      .closest("li")
      ?.querySelector(".document-list-meta")?.textContent;
  expect(meta("Spec doc")).toBe("Spec of Launch");
  expect(meta("Old notes")).toBe("Old launch");
  expect(meta("Brief")).toBe("T-KQ2");
  expect(meta("T-KQ4 findings")).toBe("");
  expect(meta("Loose")).toBe("");
  expect(container.textContent).not.toMatch(/Not linked|Loading links/);
  expect(documents.links).not.toHaveBeenCalled();
});

it("shows a dot named Not opened yet only on Documents never opened here, and no page icon", async () => {
  vi.mocked(documents.recent).mockResolvedValue([
    { id: "a", heading: "Fresh", opened: false },
    { id: "b", heading: "Read", opened: true },
  ]);
  const { container } = renderDocuments();
  await screen.findByRole("button", { name: "Fresh" });
  const dot = screen.getByRole("img", { name: "Not opened yet" });
  expect(dot.closest("li")).toBe(
    screen.getByRole("button", { name: "Fresh" }).closest("li"),
  );
  expect(screen.getAllByRole("img", { name: "Not opened yet" })).toHaveLength(
    1,
  );
  expect(container.querySelector(".document-list-kind")).toBeNull();
});

it("reads the time on a row as a time of day today and a weekday within the week", async () => {
  const day = 86_400_000;
  vi.mocked(documents.recent).mockResolvedValue([
    { id: "a", heading: "Today", updated_at: new Date().toISOString() },
    {
      id: "b",
      heading: "This week",
      updated_at: new Date(Date.now() - 3 * day).toISOString(),
    },
  ]);
  renderDocuments();
  await screen.findByRole("button", { name: "This week" });
  const timeOf = (title: string) =>
    screen
      .getByRole("button", { name: title })
      .closest("li")
      ?.querySelector("time")?.textContent;
  expect(timeOf("Today")).toMatch(/\d:\d\d/);
  expect(timeOf("This week")).toBe(
    new Date(Date.now() - 3 * day).toLocaleDateString(undefined, {
      weekday: "short",
    }),
  );
});

it("removes the dot from a row once its Document is opened", async () => {
  vi.mocked(documents.recent).mockResolvedValue([
    { id: "a", heading: "Fresh", opened: false },
  ]);
  vi.mocked(documents.open).mockResolvedValue({
    id: "a",
    title: "Fresh",
    body: "text",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  });
  renderDocuments();
  fireEvent.click(await screen.findByRole("button", { name: "Fresh" }));
  await screen.findByText("text");
  expect(screen.queryByRole("img", { name: "Not opened yet" })).toBeNull();
});

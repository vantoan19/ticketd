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
  fireEvent.click(screen.getByRole("button", { name: "Trash" }));
  fireEvent.click(await screen.findByRole("button", { name: "Context" }));
  expect(await screen.findByText("Preserved")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByRole("button", { name: "Document actions" });
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
  fireEvent.change(screen.getByLabelText("Search Documents"), {
    target: { value: "compass" },
  });
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
  fireEvent.change(screen.getByLabelText("Search Documents"), {
    target: { value: "missing" },
  });
  await screen.findByText(/No Documents match .missing./);
  fireEvent.click(
    screen.getByRole("button", { name: "Clear search and filters" }),
  );
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
  expect(await screen.findByText("First plan text")).toBeTruthy();
  expect(screen.getByText("Today")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search Documents"), {
    target: { value: "plan" },
  });
  await screen.findByText("1 result");
  expect(document.querySelector("mark")?.textContent).toBe("plan");
  fireEvent.click(
    screen.getByRole("button", { name: "Clear search and filters" }),
  );
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
  fireEvent.click(screen.getByRole("button", { name: "Trash" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Browse Documents" }),
  );
  expect(
    screen
      .getByRole("button", { name: "All documents" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it("an empty Documents list offers Capture inside the empty state", async () => {
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
  const captures = screen.getAllByRole("button", { name: "Capture" });
  expect(captures).toHaveLength(2);
  fireEvent.click(captures[1]!);
  expect(onCapture).toHaveBeenCalled();
});

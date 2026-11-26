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
import { Documents } from "./Documents";
import { documents, type CurrentWork, type DocumentSummary } from "./api";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";

vi.mock("./api", () => ({
  documents: {
    links: vi.fn().mockResolvedValue([[], []]),
    currentWork: vi.fn(),
    finished: vi.fn(),
    unlinked: vi.fn(),
    byTitle: vi.fn(),
    all: vi.fn(),
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

const row = (id: string, heading: string): DocumentSummary => ({
  id,
  heading,
});
const emptyWork: CurrentWork = {
  groups: [],
  finished: 0,
  unlinked: 0,
  trashed: 0,
};
/** A read the test settles by hand, to land answers out of order. */
const later = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const preferences = (more: Record<string, unknown>) =>
  localStorage.setItem("ticketd.preferences", JSON.stringify(more));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(documents.currentWork).mockResolvedValue(emptyWork);
  vi.mocked(documents.finished).mockResolvedValue([]);
  vi.mocked(documents.unlinked).mockResolvedValue([]);
  vi.mocked(documents.byTitle).mockResolvedValue([]);
  vi.mocked(documents.all).mockResolvedValue([]);
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.trash).mockResolvedValue([]);
  vi.mocked(documents.pins).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const page = (version = 0) => (
  <WorkspaceChangeProvider value={version}>
    <Documents
      active
      capture={false}
      onCaptureClose={vi.fn()}
      currentTicket={null}
      onOpenTicket={vi.fn()}
      onOpenPlan={vi.fn()}
      target={null}
    />
  </WorkspaceChangeProvider>
);
const renderDocuments = () => render(page());
const openMenu = () =>
  fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), {
    button: 0,
    ctrlKey: false,
  });
const toggleUpdateDetails = async () => {
  openMenu();
  fireEvent.click(
    await screen.findByRole("menuitemcheckbox", {
      name: "Show update details",
    }),
  );
};

it("gives Recent's Tab stop to a row that is shown when its first Document also sits in a Current work group", async () => {
  preferences({ documentsView: "recent" });
  vi.mocked(documents.recent).mockResolvedValue([row("r1", "Checkout spec")]);
  vi.mocked(documents.currentWork).mockResolvedValue({
    ...emptyWork,
    groups: [
      {
        plan: { id: "p1", name: "Checkout" },
        documents: [row("r1", "Checkout spec")],
      },
    ],
  });
  renderDocuments();
  const shown = await screen.findByRole("button", { name: "Checkout spec" });
  await waitFor(() => expect(documents.currentWork).toHaveBeenCalled());
  expect(shown.tabIndex).toBe(0);
});

it("keeps Recent and Pinned when Current work cannot be read, and offers Retry", async () => {
  preferences({ documentsView: "recent" });
  vi.mocked(documents.recent).mockResolvedValue([row("r1", "Recent note")]);
  vi.mocked(documents.pins).mockResolvedValue([row("p1", "Pinned note")]);
  vi.mocked(documents.currentWork).mockRejectedValueOnce(new Error("busy"));
  renderDocuments();
  expect(
    await screen.findByRole("button", { name: "Recent note" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pinned note" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(documents.currentWork).toHaveBeenCalledTimes(2));
});

it("ignores a sorted list that answers after the sort changed", async () => {
  preferences({ documentsView: "recent", documentsSort: "updated" });
  const slow = later<DocumentSummary[]>();
  vi.mocked(documents.all).mockReturnValue(slow.promise);
  vi.mocked(documents.byTitle).mockResolvedValue([row("t", "By title")]);
  renderDocuments();
  await waitFor(() => expect(documents.all).toHaveBeenCalled());
  openMenu();
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Title" }));
  await screen.findByRole("button", { name: "By title" });
  slow.resolve([row("u", "By update")]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("button", { name: "By update" })).toBeNull();
  expect(screen.getByRole("button", { name: "By title" })).toBeTruthy();
});

it("ignores a fold that answers after Show update details changed", async () => {
  preferences({ documentGroups: { finished: true } });
  vi.mocked(documents.currentWork).mockResolvedValue({
    ...emptyWork,
    finished: 2,
  });
  const slow = later<DocumentSummary[]>();
  vi.mocked(documents.finished).mockImplementation((_offset, support) =>
    support ? Promise.resolve([row("n", "With details")]) : slow.promise,
  );
  renderDocuments();
  await waitFor(() =>
    expect(documents.finished).toHaveBeenCalledWith(0, false),
  );
  await toggleUpdateDetails();
  await screen.findByRole("button", { name: "With details" });
  slow.resolve([row("o", "Without details")]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("button", { name: "Without details" })).toBeNull();
  expect(screen.getByRole("button", { name: "With details" })).toBeTruthy();
});

it("keeps a failed fold's own error and Retry when the other fold loads", async () => {
  preferences({ documentGroups: { finished: true, unlinked: true } });
  vi.mocked(documents.currentWork).mockResolvedValue({
    ...emptyWork,
    finished: 1,
    unlinked: 1,
  });
  vi.mocked(documents.finished).mockRejectedValueOnce(new Error("busy"));
  vi.mocked(documents.finished).mockResolvedValue([row("f", "Shipped notes")]);
  vi.mocked(documents.unlinked).mockResolvedValue([row("u", "Loose notes")]);
  renderDocuments();
  await screen.findByRole("button", { name: "Loose notes" });
  const finished = screen
    .getByRole("button", { name: /^Finished work/ })
    .closest(".documents-group-block") as HTMLElement;
  expect(within(finished).queryByText("Loading Documents…")).toBeNull();
  fireEvent.click(within(finished).getByRole("button", { name: "Retry" }));
  await within(finished).findByRole("button", { name: "Shipped notes" });
  expect(documents.unlinked).toHaveBeenCalledTimes(1);
});

it("keeps a Tab stop on a shown item when a fold's refresh fails under the focused row", async () => {
  preferences({ documentGroups: { finished: true } });
  vi.mocked(documents.currentWork).mockResolvedValue({
    ...emptyWork,
    finished: 1,
  });
  vi.mocked(documents.finished).mockResolvedValueOnce([
    row("f", "Shipped notes"),
  ]);
  const { rerender } = renderDocuments();
  const shipped = await screen.findByRole("button", { name: "Shipped notes" });
  fireEvent.focus(shipped);
  vi.mocked(documents.finished).mockRejectedValue(new Error("busy"));
  rerender(page(1));
  const fold = screen
    .getByRole("button", { name: /^Finished work/ })
    .closest(".documents-group-block") as HTMLElement;
  await within(fold).findByRole("button", { name: "Retry" });
  expect(screen.queryByRole("button", { name: "Shipped notes" })).toBeNull();
  // The row is gone, so the Tab stop falls back to a header that is on screen.
  const stops = screen
    .getAllByRole("button")
    .filter((button) => button.getAttribute("tabindex") === "0");
  expect(stops).toHaveLength(1);
});

it("applies Show update details at once while the pointer rests on the list", async () => {
  preferences({ documentsView: "recent" });
  vi.mocked(documents.recent).mockImplementation(async (_offset, support) =>
    support
      ? [row("r1", "Checkout spec"), row("r2", "Update detail")]
      : [row("r1", "Checkout spec")],
  );
  const { container } = renderDocuments();
  await screen.findByRole("button", { name: "Checkout spec" });
  fireEvent.pointerEnter(
    container.querySelector(".documents-list-view") as Element,
  );
  await toggleUpdateDetails();
  expect(
    await screen.findByRole("button", { name: "Update detail" }),
  ).toBeTruthy();
});

it("still holds back a background refresh while the pointer rests on the list", async () => {
  preferences({ documentsView: "recent" });
  let calls = 0;
  vi.mocked(documents.recent).mockImplementation(async () =>
    calls++ === 0 ? [row("r1", "Checkout spec")] : [row("r2", "Moved row")],
  );
  const { container, rerender } = renderDocuments();
  await screen.findByRole("button", { name: "Checkout spec" });
  const list = container.querySelector(".documents-list-view") as Element;
  fireEvent.pointerEnter(list);
  // A change elsewhere in the Workspace refreshes the list in the background.
  rerender(page(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("button", { name: "Moved row" })).toBeNull();
  fireEvent.pointerLeave(list);
  expect(await screen.findByRole("button", { name: "Moved row" })).toBeTruthy();
});

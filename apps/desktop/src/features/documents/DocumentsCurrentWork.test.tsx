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

const ticket = (reference: string, status = "In progress") => ({
  reference,
  title: "Work",
  status,
});
const row = (
  id: string,
  heading: string,
  more: Partial<DocumentSummary> = {},
): DocumentSummary => ({ id, heading, ...more });

const work = (more: Partial<CurrentWork> = {}): CurrentWork => ({
  groups: [
    {
      plan: { id: "p1", name: "Checkout" },
      documents: [
        row("s", "Checkout spec", {
          plans: [{ name: "Checkout", archived: false, spec: true }],
        }),
        row("l", "Checkout log", { tickets: [ticket("T-AB1")] }),
      ],
    },
    {
      plan: null,
      documents: [row("o", "Loose brief", { tickets: [ticket("T-AB9")] })],
    },
  ],
  finished: 3,
  unlinked: 2,
  trashed: 4,
  ...more,
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(documents.currentWork).mockResolvedValue(work());
  vi.mocked(documents.finished).mockResolvedValue([]);
  vi.mocked(documents.unlinked).mockResolvedValue([]);
  vi.mocked(documents.byTitle).mockResolvedValue([]);
  vi.mocked(documents.all).mockResolvedValue([]);
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.trash).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

const header = (name: string | RegExp) => screen.findByRole("button", { name });

it("opens on Current work: a header per Plan with its count, the spec first, then Open tickets, then two closed lines", async () => {
  renderDocuments();
  const checkout = await header(/^Checkout\s*2$/);
  expect(checkout.getAttribute("aria-expanded")).toBe("true");
  expect(
    screen
      .getByRole("radio", { name: /^Current work\s*3$/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  const titles = screen
    .getAllByRole("button")
    .map((button) => button.textContent ?? "")
    .filter((text) =>
      /Checkout \d|Checkout spec|Checkout log|Loose brief|Open tickets|Finished work|No Plan or ticket/.test(
        text,
      ),
    );
  expect(titles).toEqual([
    "Checkout 2",
    "Checkout spec",
    "Checkout log",
    "Open tickets 1",
    "Loose brief",
    "Finished work 3",
    "No Plan or ticket 2",
  ]);
  for (const name of [/^Finished work/, /^No Plan or ticket/])
    expect(
      screen.getByRole("button", { name }).getAttribute("aria-expanded"),
    ).toBe("false");
  expect(screen.queryByRole("radio", { name: "All" })).toBeNull();
});

it("says Spec or the ticket reference on a row inside a Plan group, never the Plan's name", async () => {
  renderDocuments();
  await header(/^Checkout\s*\d$/);
  const meta = (title: string) =>
    screen
      .getByRole("button", { name: title })
      .closest("li")
      ?.querySelector(".document-list-meta")?.textContent;
  expect(meta("Checkout spec")).toBe("Spec");
  expect(meta("Checkout log")).toBe("T-AB1");
  expect(meta("Loose brief")).toBe("T-AB9");
});

it("loads Finished work and No Plan or ticket only when they are opened", async () => {
  vi.mocked(documents.finished).mockResolvedValue([
    row("f", "Shipped notes", {
      plans: [{ name: "Old launch", archived: true, spec: false }],
    }),
  ]);
  renderDocuments();
  const finished = await header(/^Finished work/);
  expect(documents.finished).not.toHaveBeenCalled();
  expect(documents.unlinked).not.toHaveBeenCalled();
  fireEvent.click(finished);
  const shipped = await screen.findByRole("button", { name: "Shipped notes" });
  expect(documents.finished).toHaveBeenCalledWith(0, false);
  expect(finished.getAttribute("aria-expanded")).toBe("true");
  // Outside the Plan groups a row names its Plan.
  expect(shipped.closest("li")?.textContent).toContain("Old launch");
  expect(documents.unlinked).not.toHaveBeenCalled();
});

it("remembers which groups are open and the chosen view on this computer", async () => {
  const first = renderDocuments();
  fireEvent.click(await header(/^Checkout\s*2$/));
  expect(screen.queryByRole("button", { name: "Checkout log" })).toBeNull();
  first.unmount();

  renderDocuments();
  const checkout = await header(/^Checkout\s*2$/);
  expect(checkout.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Checkout log" })).toBeNull();

  fireEvent.click(screen.getByRole("radio", { name: "Recent" }));
  cleanup();
  renderDocuments();
  await waitFor(() =>
    expect(
      screen
        .getByRole("radio", { name: "Recent" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

it("holds the sort order, update details and Trash in one menu, and sorts Recent by each order", async () => {
  vi.mocked(documents.recent).mockResolvedValue([row("r", "Opened lately")]);
  vi.mocked(documents.all).mockResolvedValue([row("u", "Updated lately")]);
  vi.mocked(documents.byTitle).mockResolvedValue([row("t", "Alphabetical")]);
  renderDocuments();
  fireEvent.click(await screen.findByRole("radio", { name: "Recent" }));
  await screen.findByRole("button", { name: "Opened lately" });

  const openMenu = () =>
    fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), {
      button: 0,
      ctrlKey: false,
    });
  openMenu();
  expect(
    await screen.findByRole("menuitemradio", { name: "Recently opened" }),
  ).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: /^Trash\s*4$/ })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: "Recently updated" }),
  );
  await screen.findByRole("button", { name: "Updated lately" });

  openMenu();
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Title" }));
  await screen.findByRole("button", { name: "Alphabetical" });

  openMenu();
  fireEvent.click(
    await screen.findByRole("menuitemcheckbox", {
      name: "Show update details",
    }),
  );
  await waitFor(() =>
    expect(documents.byTitle).toHaveBeenLastCalledWith(0, true),
  );
  expect(documents.currentWork).toHaveBeenLastCalledWith(true);
});

it("opens Trash from the menu and comes back with the Documents crumb", async () => {
  vi.mocked(documents.trash).mockResolvedValue([row("x", "Old draft")]);
  renderDocuments();
  await header(/^Checkout\s*\d$/);
  fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Trash/ }));
  await screen.findByRole("button", { name: "Old draft" });
  fireEvent.click(screen.getByRole("button", { name: "Back to Documents" }));
  await header(/^Checkout\s*\d$/);
});

it("puts group headers in the list's roving order beside the rows", async () => {
  renderDocuments();
  const checkout = await header(/^Checkout\s*2$/);
  const spec = screen.getByRole("button", { name: "Checkout spec" });
  expect(checkout.tabIndex).toBe(0);
  expect(spec.tabIndex).toBe(-1);
  checkout.focus();
  fireEvent.keyDown(checkout, { key: "ArrowDown" });
  expect(document.activeElement).toBe(spec);
  fireEvent.keyDown(spec, { key: "ArrowUp" });
  expect(document.activeElement).toBe(checkout);
  fireEvent.keyDown(checkout, { key: "End" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /^No Plan or ticket/ }),
  );
  fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
  expect(document.activeElement).toBe(checkout);
  // Opening the list pane at its Pinned group still works for rows.
  expect(
    within(screen.getByRole("region", { name: "Current work" })).getAllByRole(
      "listitem",
    ).length,
  ).toBe(3);
});

// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Documents } from "./Documents";
import { documents } from "./api";

vi.mock("./api", () => ({
  documents: {
    currentWork: vi.fn(),
    links: vi.fn().mockResolvedValue([[], []]),
    summary: vi.fn().mockResolvedValue({
      id: "d1",
      heading: "",
      plans: [],
      tickets: [],
      tags: [],
    }),
    recent: vi.fn(),
    pins: vi.fn(),
    tags: vi.fn(),
    trash: vi.fn(),
    open: vi.fn(),
    show: vi.fn(),
    setTrashed: vi.fn(),
    save: vi.fn(),
    keep: vi.fn(),
  },
}));
vi.mock("@/features/markdown/LazyMarkdownEditor", () => ({
  LazyMarkdownEditor: ({ value }: { value: string }) => <p>{value}</p>,
}));
beforeEach(() => {
  // These tests browse Recent; Current work has its own file.
  localStorage.setItem(
    "ticketd.preferences",
    JSON.stringify({ documentsView: "recent" }),
  );
  vi.mocked(documents.links).mockResolvedValue([[], []]);
  vi.mocked(documents.row).mockResolvedValue({
    id: "d1",
    heading: "",
    plans: [],
    tickets: [],
    tags: [],
  });
  vi.mocked(documents.currentWork).mockResolvedValue({
    groups: [],
    finished: 0,
    unlinked: 0,
    trashed: 0,
  });
});
const openTrash = async () => {
  fireEvent.pointerDown(await screen.findByRole("button", { name: "More" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Trash/ }));
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
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
  vi.mocked(documents.pins).mockResolvedValue([]);
  vi.mocked(documents.tags).mockResolvedValue([]);
  vi.mocked(documents.recent).mockImplementation(async () =>
    trashed ? [] : [{ id: doc.id, heading: "Context" }],
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
  expect(documents.trash).not.toHaveBeenCalled();
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
  await openTrash();
  fireEvent.click(await screen.findByRole("button", { name: "Context" }));
  expect(await screen.findByText("Preserved")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByRole("button", { name: "Document actions" });
});

it("includes Activity details on request and keeps a selected detail", async () => {
  const doc = {
    id: "detail",
    title: null,
    body: "Details",
    created_at: "now",
    updated_at: "now",
    trashed: false,
    origin_brief: "Update",
    kept: false,
  };
  vi.mocked(documents.links).mockResolvedValue([[], []]);
  vi.mocked(documents.pins).mockResolvedValue([]);
  vi.mocked(documents.tags).mockResolvedValue([]);
  vi.mocked(documents.trash).mockResolvedValue([]);
  vi.mocked(documents.recent).mockImplementation(async (_offset, include) =>
    include ? [{ id: doc.id, heading: "Update", origin_ticket: "T-KQ1" }] : [],
  );
  vi.mocked(documents.open).mockResolvedValue(doc);
  vi.mocked(documents.keep).mockResolvedValue({ ...doc, kept: true });
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
  fireEvent.pointerDown(await screen.findByRole("button", { name: "More" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(
    await screen.findByRole("menuitemcheckbox", {
      name: "Show update details",
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  expect(screen.getByText("Update details · T-KQ1")).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("button", { name: "Keep in Documents" }),
  );
  await waitFor(() =>
    expect(documents.keep).toHaveBeenCalledWith("detail", expect.any(String)),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Keep in Documents" }),
    ).toBeNull(),
  );
});

it("says what Restore did and keeps focus in the Trash list", async () => {
  let trash = [
    { id: "a", heading: "Alpha" },
    { id: "b", heading: "Beta" },
  ];
  vi.mocked(documents.pins).mockResolvedValue([]);
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.trash).mockImplementation(async () => trash);
  vi.mocked(documents.setTrashed).mockImplementation(async (id) => {
    trash = trash.filter((doc) => doc.id !== id);
    return {
      id,
      title: null,
      body: "",
      created_at: "now",
      updated_at: "now",
      trashed: false,
    };
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
  await openTrash();
  fireEvent.click(await screen.findByRole("button", { name: "Restore Alpha" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Restore Beta" }),
    ),
  );
  expect(screen.getByText("Restored Alpha.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
});

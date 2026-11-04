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
  fireEvent.click(await screen.findByRole("button", { name: "Move to Trash" }));
  await screen.findByText("In Trash");
  fireEvent.click(screen.getByRole("button", { name: "Back to work" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Context" })).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Trash" }));
  fireEvent.click(await screen.findByRole("button", { name: "Context" }));
  expect(await screen.findByText("Preserved")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByRole("button", { name: "Move to Trash" });
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
    include ? [{ id: doc.id, heading: "Update", origin_ticket: "T-1" }] : [],
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
  fireEvent.click(screen.getByLabelText("Include Activity details"));
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  expect(screen.getByText("Activity details · T-1")).toBeTruthy();
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

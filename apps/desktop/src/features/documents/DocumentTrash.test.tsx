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
    recent: vi.fn(),
    pins: vi.fn(),
    tags: vi.fn(),
    trash: vi.fn(),
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
    trashed ? [{ ...doc, trashed }] : [],
  );
  vi.mocked(documents.open).mockImplementation(async () => ({
    ...doc,
    trashed,
  }));
  vi.mocked(documents.setTrashed).mockImplementation(async (_id, value) => {
    trashed = value;
    return { ...doc, trashed };
  });
  render(<Documents active capture={false} onCaptureClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Context" }));
  fireEvent.click(await screen.findByRole("button", { name: "Move to Trash" }));
  await screen.findByText("This Document is in Trash.");
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

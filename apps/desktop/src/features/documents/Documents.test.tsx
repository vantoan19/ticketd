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
    trash: vi.fn(),
    pins: vi.fn(),
    search: vi.fn(),
    pin: vi.fn(),
    open: vi.fn(),
    tags: vi.fn(),
    tag: vi.fn(),
  },
}));
vi.mock("./DocumentEditor", () => ({
  DocumentEditor: () => <div>Editor</div>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("searches and opens a result using keyboard accessible controls", async () => {
  vi.mocked(documents.recent).mockResolvedValue([]);
  vi.mocked(documents.trash).mockResolvedValue([]);
  vi.mocked(documents.pins).mockResolvedValue([]);
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
  vi.mocked(documents.tags).mockResolvedValue([]);
  render(<Documents active capture={false} onCaptureClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Search Documents"), {
    target: { value: "compass" },
  });
  const result = await screen.findByRole("button", { name: "Compass" });
  result.focus();
  expect(document.activeElement).toBe(result);
  fireEvent.click(result);
  await screen.findByText("Editor");
  await waitFor(() => expect(documents.open).toHaveBeenCalledWith("1"));
});

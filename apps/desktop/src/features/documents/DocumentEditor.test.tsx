// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor";
import { documents } from "./api";
vi.mock("./api", () => ({ documents: { save: vi.fn(), show: vi.fn() } }));
vi.mock("@/features/markdown/LazyMarkdownEditor", () => ({
  LazyMarkdownEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Your thought"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("returns without creating an untouched capture", async () => {
  const close = vi.fn();
  render(<DocumentEditor initial={null} onClose={close} />);
  fireEvent.click(screen.getByText("Back to work"));
  expect(close).toHaveBeenCalledOnce();
  expect(documents.save).not.toHaveBeenCalled();
});
it("keeps a failed capture open and retries the same request before returning", async () => {
  vi.mocked(documents.save)
    .mockRejectedValueOnce("disk full")
    .mockResolvedValueOnce({
      id: "d1",
      title: null,
      body: "A thought",
      created_at: "now",
      updated_at: "now",
    });
  const close = vi.fn();
  render(<DocumentEditor initial={null} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Your thought"), {
    target: { value: "A thought" },
  });
  fireEvent.click(screen.getByText("Back to work"));
  await screen.findByText(/Could not save/);
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Retry"));
  await waitFor(() => expect(documents.save).toHaveBeenCalledTimes(2));
  expect(vi.mocked(documents.save).mock.calls[0]).toEqual(
    vi.mocked(documents.save).mock.calls[1],
  );
  await screen.findByText("Saved locally");
  fireEvent.click(screen.getByText("Back to work"));
  expect(close).toHaveBeenCalledOnce();
});
it("defers external refresh while the editor has focus", async () => {
  vi.useFakeTimers();
  const original = {
    id: "d1",
    title: null,
    body: "Original",
    created_at: "now",
    updated_at: "now",
  };
  vi.mocked(documents.show).mockResolvedValue({
    ...original,
    body: "Changed externally",
  });
  render(<DocumentEditor initial={original} onClose={vi.fn()} />);
  const editor = screen.getByLabelText("Your thought");
  editor.focus();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(documents.show).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(editor);
  screen.getByText("Back to work").focus();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(documents.show).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Your thought")).toHaveProperty(
    "value",
    "Changed externally",
  );
  vi.useRealTimers();
});

// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BulkTagDialog } from "./BulkTagDialog";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const onApply = vi.fn();
const onOpenChange = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(
    async (command: string, args: { query: string }) => {
      if (command !== "search_tags") throw new Error(`unexpected ${command}`);
      return ["needs-review", "needs-design", "bug"].filter((tag) =>
        tag.includes(args.query),
      );
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

async function renderDialog() {
  render(
    <BulkTagDialog
      open
      onOpenChange={onOpenChange}
      count={2}
      onApply={onApply}
    />,
  );
  await settle();
  return screen.getByRole("combobox", { name: "Tag name" });
}

test("suggests existing tags as you type and picks one with the keyboard alone", async () => {
  const input = await renderDialog();
  fireEvent.change(input, { target: { value: "needs" } });
  await settle();
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "needs-review",
    "needs-design",
  ]);
  expect(input.getAttribute("aria-expanded")).toBe("true");

  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  const second = screen.getByRole("option", { name: "needs-design" });
  expect(input.getAttribute("aria-activedescendant")).toBe(second.id);
  expect(second.getAttribute("aria-selected")).toBe("true");

  // Enter picks the suggestion without adding the tag yet.
  fireEvent.keyDown(input, { key: "Enter" });
  expect((input as HTMLInputElement).value).toBe("needs-design");
  expect(onApply).not.toHaveBeenCalled();
});

test("Escape closes the suggestions first, then the dialog", async () => {
  const input = await renderDialog();
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(onOpenChange).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("still accepts a typed tag when suggestions are unavailable", async () => {
  bridge.invoke.mockRejectedValue(new Error("offline"));
  const input = await renderDialog();
  expect(screen.getByText(/suggestions unavailable/i)).toBeTruthy();
  fireEvent.change(input, { target: { value: "new-tag" } });
  fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
  expect(onApply).toHaveBeenCalledWith("add", "new-tag");
});

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

// cmdk needs these, which jsdom lacks.
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

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

async function renderDialog(mode: "add" | "remove" = "add") {
  render(
    <BulkTagDialog
      open
      onOpenChange={onOpenChange}
      count={2}
      mode={mode}
      onApply={onApply}
    />,
  );
  await settle();
  return screen.getByLabelText("Search tags");
}

const options = () => screen.getAllByRole("option").map((o) => o.textContent);

async function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  await settle();
}

test("lists existing tags as you type; choosing one marks it and Add applies it", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  expect(options()).toEqual(["needs-review", "needs-design", "Create “needs”"]);
  const add = screen.getByRole("button", { name: "Add tag" });
  expect(add.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Choose or create a tag.")).toBeTruthy();

  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onApply).not.toHaveBeenCalled();
  expect(screen.getByText("Adds “needs-design” to 2 tickets.")).toBeTruthy();
  fireEvent.click(add);
  expect(onApply).toHaveBeenCalledWith("add", "needs-design");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("a new tag is created from the typed words", async () => {
  const input = await renderDialog();
  await type(input, "ux");
  fireEvent.click(screen.getByRole("option", { name: "Create “ux”" }));
  fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
  expect(onApply).toHaveBeenCalledWith("add", "ux");
});

test("removing offers only existing tags", async () => {
  const input = await renderDialog("remove");
  await type(input, "zzz");
  expect(screen.queryByRole("option", { name: /Create/ })).toBeNull();
  await type(input, "bug");
  fireEvent.click(screen.getByRole("option", { name: "bug" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove tag" }));
  expect(onApply).toHaveBeenCalledWith("remove", "bug");
});

test("a reopened dialog starts without the old query or choice", async () => {
  const props = { onOpenChange, count: 2, mode: "add" as const, onApply };
  const view = render(<BulkTagDialog open {...props} />);
  await settle();
  await type(screen.getByLabelText("Search tags"), "needs");
  fireEvent.click(screen.getByRole("option", { name: "needs-review" }));
  view.rerender(<BulkTagDialog open={false} {...props} />);
  bridge.invoke.mockImplementation(() => new Promise(() => {}));
  view.rerender(<BulkTagDialog open {...props} />);
  expect((screen.getByLabelText("Search tags") as HTMLInputElement).value).toBe(
    "",
  );
  expect(screen.queryAllByRole("option")).toHaveLength(0);
});

test("still accepts a typed tag when suggestions are unavailable", async () => {
  bridge.invoke.mockRejectedValue(new Error("offline"));
  const input = await renderDialog();
  expect(screen.getByText(/suggestions unavailable/i)).toBeTruthy();
  await type(input, "new-tag");
  fireEvent.click(screen.getByRole("option", { name: "Create “new-tag”" }));
  fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
  expect(onApply).toHaveBeenCalledWith("add", "new-tag");
});

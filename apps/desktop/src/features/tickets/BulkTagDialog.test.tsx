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

const listbox = () => screen.getByRole("listbox", { hidden: true });
const options = () => screen.getAllByRole("option").map((o) => o.textContent);

async function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  await settle();
}

const active = (input: HTMLElement) =>
  input.getAttribute("aria-activedescendant");
const optionId = (name: string) => screen.getByRole("option", { name }).id;

test("suggests existing tags as you type and picks one with the keyboard alone", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  expect(options()).toEqual(["needs-review", "needs-design"]);
  expect(listbox().hidden).toBe(false);

  // The first Down highlights the first option and announces it.
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(active(input)).toBe(optionId("needs-review"));
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(active(input)).toBe(optionId("needs-design"));

  // Enter picks the suggestion without adding the tag yet; a second adds it.
  fireEvent.keyDown(input, { key: "Enter" });
  expect((input as HTMLInputElement).value).toBe("needs-design");
  expect(onApply).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onApply).toHaveBeenCalledWith("add", "needs-design");
});

test("highlights nothing until the person moves, and Enter then adds the typed text", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  expect(active(input)).toBeNull();
  expect(
    screen.getAllByRole("option").some((o) => o.ariaSelected === "true"),
  ).toBe(false);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onApply).toHaveBeenCalledWith("add", "needs");
});

test("ArrowUp with nothing highlighted goes to the last suggestion", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(active(input)).toBe(optionId("needs-design"));
});

test("hovering an option highlights it, and Enter picks it", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  fireEvent.pointerMove(screen.getByRole("option", { name: "needs-design" }));
  expect(active(input)).toBe(optionId("needs-design"));
  fireEvent.keyDown(input, { key: "Enter" });
  expect((input as HTMLInputElement).value).toBe("needs-design");
});

test("a stale highlight is dropped when the text changes", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.change(input, { target: { value: "needs-d" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onApply).toHaveBeenCalledWith("add", "needs-d");
});

test("a blank query shows no list until ArrowDown", async () => {
  const input = await renderDialog();
  await type(input, " ");
  expect(listbox().hidden).toBe(true);
  expect(input.getAttribute("aria-expanded")).toBe("false");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(listbox().hidden).toBe(false);
  expect(input.getAttribute("aria-expanded")).toBe("true");
});

test("moving focus away closes the list", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  fireEvent.blur(input);
  expect(listbox().hidden).toBe(true);
});

test("pressing on an option or the list keeps focus in the field, but the field itself stays normal", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  expect(
    fireEvent.mouseDown(screen.getByRole("option", { name: "needs-review" })),
  ).toBe(false);
  expect(fireEvent.mouseDown(listbox())).toBe(false);
  expect(fireEvent.mouseDown(input)).toBe(true);
});

test("picks a suggestion with the mouse", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  fireEvent.click(screen.getByRole("option", { name: "needs-review" }));
  expect((input as HTMLInputElement).value).toBe("needs-review");
  expect(listbox().hidden).toBe(true);
});

test("keeps Home and End as text caret keys", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "End" });
  expect(active(input)).toBe(optionId("needs-review"));
  fireEvent.keyDown(input, { key: "Home" });
  expect(active(input)).toBe(optionId("needs-review"));
});

test("a reopened dialog starts without the old list or highlight", async () => {
  const props = { onOpenChange, count: 2, onApply };
  const view = render(<BulkTagDialog open {...props} />);
  await settle();
  const input = screen.getByRole("combobox", { name: "Tag name" });
  await type(input, "needs");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  view.rerender(<BulkTagDialog open={false} {...props} />);
  bridge.invoke.mockImplementation(() => new Promise(() => {}));
  view.rerender(<BulkTagDialog open {...props} />);
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(active(screen.getByRole("combobox"))).toBeNull();
});

test("Escape during IME composition does not close the dialog", async () => {
  const input = await renderDialog();
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(onOpenChange).not.toHaveBeenCalled();
});

test("Escape closes the suggestions first, then the dialog", async () => {
  const input = await renderDialog();
  await type(input, "needs");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(listbox().hidden).toBe(true);
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

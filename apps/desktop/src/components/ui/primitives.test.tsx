// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DialogShell } from "@/components/ui/dialog-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Picker } from "@/components/ui/picker";
import { useInputModality } from "@/lib/input-modality";

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

test("an empty state names what will appear and offers its action", () => {
  render(
    <EmptyState
      icon={<svg />}
      title="Nothing here"
      description="Things appear here."
      action={<button>Do it</button>}
    />,
  );
  expect(screen.getByText("Nothing here")).toBeTruthy();
  expect(screen.getByText("Things appear here.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Do it" })).toBeTruthy();
});

test("an inline empty state keeps its words and action in one status row", () => {
  render(
    <EmptyState
      size="inline"
      role="status"
      description="Link a pull request."
      action={<button>Add</button>}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Link a pull request.",
  );
  expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
});

test("a hint empty state is a quiet line with its footnote and no action", () => {
  render(
    <EmptyState
      size="hint"
      title="Select a ticket to read it here"
      footnote={<kbd>Enter</kbd>}
    />,
  );
  expect(screen.getByText("Select a ticket to read it here")).toBeTruthy();
  expect(screen.getByText("Enter")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("a block empty state lays several actions side by side", () => {
  render(
    <EmptyState
      icon={<svg />}
      title="Nothing"
      description="Nothing yet."
      action={
        <>
          <button>One</button>
          <button>Two</button>
        </>
      }
    />,
  );
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "One",
    "Two",
  ]);
});

test("a picker is named by its label and current value", () => {
  render(
    <Picker
      label="Status"
      value="todo"
      onValueChange={vi.fn()}
      options={[
        { value: "todo", label: "Todo" },
        { value: "done", label: "Done" },
      ]}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Status: Todo" })).toBeTruthy();
});

test("a dialog's primary action stays disabled and says why until the form is valid", () => {
  const onSubmit = vi.fn();
  const shell = (blockedReason: string | null) => (
    <DialogShell
      open
      onOpenChange={vi.fn()}
      title="Register checkout"
      primaryLabel="Register"
      blockedReason={blockedReason}
      onSubmit={onSubmit}
    >
      body
    </DialogShell>
  );
  const view = render(shell("Choose a folder to continue"));
  const primary = screen.getByRole("button", { name: "Register" });
  expect(primary.hasAttribute("disabled")).toBe(true);
  expect(primary.getAttribute("aria-describedby")).toBeTruthy();
  expect(screen.getByText("Choose a folder to continue")).toBeTruthy();
  view.rerender(shell(null));
  fireEvent.click(screen.getByRole("button", { name: "Register" }));
  expect(onSubmit).toHaveBeenCalledOnce();
});

function Modality() {
  useInputModality();
  return <button>Inbox</button>;
}

test("focus rings are for the keyboard: a click marks pointer input, a key restores it", () => {
  render(<Modality />);
  const root = document.documentElement;
  fireEvent.pointerDown(screen.getByRole("button", { name: "Inbox" }));
  expect(root.dataset.input).toBe("pointer");
  fireEvent.keyDown(document.body, { key: "Tab" });
  expect(root.dataset.input).toBe("keyboard");
});

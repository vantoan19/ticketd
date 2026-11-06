// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { DialogShell } from "@/components/ui/dialog-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Picker } from "@/components/ui/picker";
import { TokenField } from "@/components/ui/token-field";
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

function Tokens() {
  const [values, setValues] = useState(["api"]);
  return <TokenField label="Tags" values={values} onChange={setValues} />;
}

test("a token field adds on Enter, ignores duplicates, and removes by name or Backspace", () => {
  render(<Tokens />);
  const input = screen.getByRole("textbox", { name: "Tags" });
  fireEvent.change(input, { target: { value: "ui" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.change(input, { target: { value: "api" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Remove api" }));
  expect(screen.queryByRole("button", { name: "Remove api" })).toBeNull();
  fireEvent.keyDown(input, { key: "Backspace" });
  expect(screen.queryByRole("button", { name: "Remove ui" })).toBeNull();
});

test("a token field ignores case-insensitive duplicates and IME composition", () => {
  render(<Tokens />);
  const input = screen.getByRole("textbox", { name: "Tags" });
  fireEvent.change(input, { target: { value: "API" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
  fireEvent.change(input, { target: { value: "ui" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(2);
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

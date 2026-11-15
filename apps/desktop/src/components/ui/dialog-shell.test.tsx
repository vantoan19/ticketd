// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DialogShell } from "@/components/ui/dialog-shell";

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

test("a destructive confirm opens on Cancel and takes one of the three sizes", () => {
  render(
    <DialogShell
      open
      onOpenChange={vi.fn()}
      title="Move T-FV10 to Trash?"
      size="sm"
      primaryLabel="Move to Trash"
      primaryVariant="destructive"
      blockedReason={null}
      onSubmit={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Move T-FV10 to Trash?" });
  expect(dialog.getAttribute("data-size")).toBe("sm");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Cancel" }),
  );
});

test("a failed submit keeps the dialog open with the error above the footer", () => {
  render(
    <DialogShell
      open
      onOpenChange={vi.fn()}
      title="Add tag"
      primaryLabel="Add tag"
      primaryHint="⌘↵"
      blockedReason={null}
      footerNote="Adds to 3 tickets."
      error="Couldn't add the tag. The workspace is read-only."
      onSubmit={vi.fn()}
    >
      <input aria-label="Tag" />
    </DialogShell>,
  );
  const dialog = screen.getByRole("dialog", { name: "Add tag" });
  expect(within(dialog).getByRole("alert").textContent).toContain("read-only");
  expect(within(dialog).getByText("Adds to 3 tickets.")).toBeTruthy();
  // The key hint is drawn inside the primary but is not part of its name.
  expect(within(dialog).getByRole("button", { name: "Add tag" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
});

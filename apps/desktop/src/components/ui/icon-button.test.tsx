// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { IconButton } from "@/components/ui/icon-button";

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

/** Focus as the Tab key moves it: the keydown comes first. */
function tabTo(element: HTMLElement) {
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => element.focus());
}

test("an icon-only button is named by its label and explains itself on keyboard focus", async () => {
  render(
    <IconButton label="Refresh">
      <svg aria-hidden="true" />
    </IconButton>,
  );
  tabTo(screen.getByRole("button", { name: "Refresh" }));
  expect((await screen.findByRole("tooltip")).textContent).toBe("Refresh");
});

test("the label closes when a dialog opens over the button and stays closed when focus returns", async () => {
  render(
    <IconButton label="Ticket actions">
      <svg aria-hidden="true" />
    </IconButton>,
  );
  const button = screen.getByRole("button", { name: "Ticket actions" });
  tabTo(button);
  await screen.findByRole("tooltip");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  dialog.remove();
  // The dialog closed with Enter and returned focus to its opener.
  act(() => button.blur());
  fireEvent.keyDown(document.body, { key: "Enter" });
  act(() => button.focus());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("a shortcut shows in the tooltip after the label and stays out of the name", async () => {
  render(
    <IconButton label="Stop" shortcut="Esc">
      <svg aria-hidden="true" />
    </IconButton>,
  );
  tabTo(screen.getByRole("button", { name: "Stop" }));
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toBe("StopEsc");
  expect(tooltip.querySelector("kbd")?.textContent).toBe("Esc");
});

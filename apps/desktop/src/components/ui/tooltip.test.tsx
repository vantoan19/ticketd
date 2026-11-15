// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Tooltip } from "@/components/ui/tooltip";

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

test("keyboard focus shows the label with its shortcut as keys", async () => {
  render(
    <Tooltip content="New ticket" shortcut="C">
      <button type="button">New</button>
    </Tooltip>,
  );
  tabTo(screen.getByRole("button", { name: "New" }));
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toBe("New ticketC");
});

test("focus returned by a closing menu or dialog does not show the label", async () => {
  render(
    <Tooltip content="Ticket actions">
      <button type="button">Actions</button>
    </Tooltip>,
  );
  // Escape closes the menu, which then moves focus back to its trigger.
  fireEvent.keyDown(document.body, { key: "Escape" });
  act(() => screen.getByRole("button", { name: "Actions" }).focus());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("with nothing to say no tooltip is mounted, so Escape reaches the page", () => {
  let escapes = 0;
  render(
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape") escapes += 1;
      }}
    >
      <Tooltip content="">
        <button type="button">Inbox</button>
      </Tooltip>
    </div>,
  );
  const button = screen.getByRole("button", { name: "Inbox" });
  expect(button.hasAttribute("data-state")).toBe(false);
  tabTo(button);
  fireEvent.keyDown(button, { key: "Escape" });
  expect(escapes).toBe(1);
});

test("an open tooltip closes when its trigger disappears while the tooltip survives", async () => {
  const { rerender } = render(
    <Tooltip content="Destination">
      <button>Go</button>
    </Tooltip>,
  );
  tabTo(screen.getByRole("button", { name: "Go" }));
  await screen.findByRole("tooltip");
  rerender(
    <Tooltip content="Destination">
      <span>Gone</span>
    </Tooltip>,
  );
  await vi.waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});

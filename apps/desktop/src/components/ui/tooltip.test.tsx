// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";

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

// A label covers what is beside its trigger (a sidebar's side-right chip lies
// over the next icon), so it cannot be a place the pointer travels to: Radix's
// grace area would keep it open and hold the neighbour's label shut. The chip
// is not hoverable, so moving to a neighbouring control opens that label at once.
test("moving straight to a neighbouring control opens its label at once", async () => {
  const rects = new Map<string, DOMRect>([
    ["Collapse", new DOMRect(160, 42, 28, 28)],
    ["New", new DOMRect(192, 42, 28, 28)],
  ]);
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const named = rects.get(this.textContent ?? "");
    if (named && this.tagName === "BUTTON") return named;
    // The chip, to the right of its trigger, lying over the neighbour.
    if (this.getAttribute("data-slot") === "tooltip-content")
      return new DOMRect(194, 44, 108, 24);
    return original.call(this);
  };
  try {
    // The app's one provider, so the second label can skip the delay.
    const pair = (
      <TooltipProvider>
        <Tooltip content="Collapse sidebar" side="right">
          <button type="button">Collapse</button>
        </Tooltip>
        <Tooltip content="New ticket" side="right">
          <button type="button">New</button>
        </Tooltip>
      </TooltipProvider>
    );
    const { rerender } = render(pair);
    const collapse = screen.getByRole("button", { name: "Collapse" });
    const next = screen.getByRole("button", { name: "New" });
    fireEvent.pointerEnter(collapse, { clientX: 174, clientY: 56 });
    fireEvent.pointerMove(collapse, { clientX: 174, clientY: 56 });
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Collapse sidebar",
    );

    // Radix reads the chip's element on its next render, as the app's does.
    rerender(pair);

    // Out of the first control and across the chip's corner onto the next.
    fireEvent.pointerLeave(collapse, { clientX: 188, clientY: 56 });
    fireEvent.pointerMove(document.body, { clientX: 196, clientY: 56 });
    fireEvent.pointerEnter(next, { clientX: 206, clientY: 56 });
    fireEvent.pointerMove(next, { clientX: 206, clientY: 56 });
    // At once: no waiting out the delay again.
    await act(async () => {});
    expect(
      screen.getAllByRole("tooltip").map((tip) => tip.textContent),
    ).toContain("New ticket");
  } finally {
    Element.prototype.getBoundingClientRect = original;
  }
});

test("a label held shut never opens the next one at once", () => {
  vi.useFakeTimers();
  try {
    render(
      <TooltipProvider>
        <Tooltip content="Held shut" disabled>
          <button type="button">First</button>
        </Tooltip>
        <Tooltip content="Next">
          <button type="button">Second</button>
        </Tooltip>
      </TooltipProvider>,
    );
    fireEvent.pointerMove(screen.getByRole("button", { name: "First" }));
    act(() => void vi.advanceTimersByTime(1000));
    fireEvent.pointerMove(screen.getByRole("button", { name: "Second" }));
    // The first label still waits its delay: nothing opened before it.
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => void vi.advanceTimersByTime(399));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByRole("tooltip")).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

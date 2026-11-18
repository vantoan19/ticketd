// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { MotionProvider, Presence } from "@/components/ui/motion";
import { DockSlot } from "@/features/chats/DockSlot";
import { Space } from "@/features/chats/arrivals";
import { motionTestbed } from "@/test/motion-testbed";

// What the Chat's tray does when a part of it opens and closes its own space:
// the slot follows a box that is moving its height, and a box that is called
// back mid-exit returns to its own height.

const { advance } = motionTestbed();

const css = readFileSync(
  join(__dirname, "../../components/ui/surface-roles/chats-chats.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");
const ruleFor = (selector: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, s = ""]) => s.trim().replace(/\s+/g, " ") === selector)
    .map(([, , body = ""]) => body)
    .join(";");

// jsdom lays nothing out: a stub reports the content's height and lets the test
// say when it changed.
let tick: () => void;
let contentHeight = 0;
vi.stubGlobal(
  "ResizeObserver",
  class {
    constructor(callback: () => void) {
      tick = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get: () => contentHeight,
});

function resize(height: number) {
  contentHeight = height;
  act(() => tick());
}

test("a change nothing is animating glides on the slot's spring", () => {
  contentHeight = 100;
  const { container } = render(
    <DockSlot>
      <p>card</p>
    </DockSlot>,
  );
  const slot = container.querySelector<HTMLElement>(".chat-dock-slot")!;
  expect(slot.style.height).toBe("100px");
  resize(200);
  expect(slot.style.height).toBe("200px");
  expect(slot.hasAttribute("data-gliding")).toBe(true);
  expect(slot.hasAttribute("data-following")).toBe(false);
});

test("a Space moving its height is followed frame by frame, then the spring is back", () => {
  contentHeight = 100;
  const { container } = render(
    <DockSlot>
      <div data-space="" style={{ height: "90px" }} />
    </DockSlot>,
  );
  const slot = container.querySelector<HTMLElement>(".chat-dock-slot")!;
  const space = container.querySelector<HTMLElement>("[data-space]")!;
  for (const height of [90, 70, 40]) {
    space.style.height = `${height}px`;
    resize(height);
    expect(slot.style.height).toBe(`${height}px`);
    expect(slot.hasAttribute("data-following")).toBe(true);
  }
  // At rest a Space is `auto`: the next change glides.
  space.style.height = "auto";
  resize(150);
  expect(slot.hasAttribute("data-following")).toBe(false);
});

test("the slot is not sprung after while it follows, and is the rest of the time", () => {
  expect(ruleFor(".chat-dock-slot[data-following]")).toMatch(
    /transition:\s*none/,
  );
  expect(ruleFor(".chat-dock-slot")).toContain("transition: height");
});

function Toggle({ initial = true }: { initial?: boolean }) {
  const [on, setOn] = useState(initial);
  return (
    <MotionProvider>
      <button onClick={() => setOn((value) => !value)}>toggle</button>
      <Presence initial={false}>
        {on && (
          <Space className="chat-queue-card">
            <span>words</span>
          </Space>
        )}
      </Presence>
    </MotionProvider>
  );
}

// jsdom measures nothing, so `auto` has no size to animate from or to: report one.
function withLayoutSize() {
  const box = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 40, 40));
  return () => box.mockRestore();
}

const moving = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-space]")].some((space) =>
    space.style.height.endsWith("px"),
  );
const click = (container: HTMLElement) =>
  act(() => container.querySelector("button")!.click());
const card = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".chat-queue-card");

test("a leaving Space is marked while it closes, takes no pointer, and is gone after", async () => {
  const restore = withLayoutSize();
  try {
    const { container } = render(<Toggle />);
    expect(card(container)!.hasAttribute("data-leaving")).toBe(false);
    click(container);
    await advance(10);
    const leaving = card(container)!;
    expect(leaving.hasAttribute("data-leaving")).toBe(true);
    await advance(2000);
    expect(card(container)).toBeNull();
  } finally {
    restore();
  }
});

test("a Space called back while it leaves ends at its own height, not the one it had reached", async () => {
  const restore = withLayoutSize();
  try {
    const { container } = render(<Toggle />);
    click(container);
    await advance(60);
    const closing = card(container)!;
    expect(Number.parseFloat(closing.style.height)).toBeLessThan(40);
    expect(moving(container)).toBe(true);
    click(container);
    await advance(2000);
    expect(moving(container)).toBe(false);
    const back = card(container)!;
    expect(back).toBe(closing);
    expect(back.style.height).toBe("auto");
    expect(back.style.overflow).not.toBe("clip");
    expect(back.hasAttribute("data-leaving")).toBe(false);
  } finally {
    restore();
  }
});

test("a leaving queue card has no hover fill and no pointer", () => {
  const body = ruleFor(".chat-queue-card[data-leaving]");
  expect(body).toMatch(/pointer-events:\s*none/);
  expect(body).toMatch(/background:\s*none/);
});

test("a settled stream chunk keeps no filter: its animation holds nothing after the fade", () => {
  for (const selector of [
    ".chat-chunk",
    '.chat-status[data-arrived] > [data-slot="status-dot"]',
  ])
    expect(ruleFor(selector), selector).not.toMatch(/\b(both|forwards)\b/);
});

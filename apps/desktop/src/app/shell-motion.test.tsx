// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BandSlot } from "@/app/WorkspaceBand";
import { useResultCascade } from "@/app/use-result-cascade";
import { Count } from "@/components/ui/count";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";

// The shell's motion that starts from a state change: the sidebar highlight,
// the workspace band, typing in the palette, counts and the narrow sheet.

const styles = readFileSync(join(__dirname, "..", "styles.css"), "utf8");

const animate = vi.fn();
let restoreTokens: () => void;
beforeEach(() => {
  animate.mockReset();
  Element.prototype.animate = animate as unknown as Element["animate"];
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
  vi.useRealTimers();
  // @ts-expect-error jsdom has no animate; remove the spy
  delete Element.prototype.animate;
});

function Menu({ current }: { current: "inbox" | "ready" }) {
  return (
    <SidebarProvider>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton isActive={current === "inbox"}>
            Inbox
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton isActive={current === "ready"}>
            Ready
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarProvider>
  );
}

it("puts the sidebar highlight beside the current row, and moves it to the next", () => {
  const { rerender } = render(<Menu current="inbox" />);
  const items = () => screen.getAllByRole("listitem");
  expect(items()[0]?.querySelector('[data-slot="glide"]')).not.toBeNull();
  expect(items()[1]?.querySelector('[data-slot="glide"]')).toBeNull();
  rerender(<Menu current="ready" />);
  expect(items()[0]?.querySelector('[data-slot="glide"]')).toBeNull();
  expect(items()[1]?.querySelector('[data-slot="glide"]')).not.toBeNull();
  // Beside the button, not inside it: the button clips what is inside.
  expect(
    screen.getByRole("button", { name: "Ready" }).querySelector("*"),
  ).toBeNull();
});

it("a count crossfades its value in place", async () => {
  const { rerender } = render(<Count>3</Count>);
  rerender(<Count>4</Count>);
  expect(await screen.findByText("4")).toBeTruthy();
  expect(
    screen.getByText("4").closest('[data-slot="crossfade"]'),
  ).not.toBeNull();
});

function Slot({ open }: { open: boolean }) {
  return (
    <BandSlot open={open}>
      <p>Read-only</p>
    </BandSlot>
  );
}

it("the band opens a frame after it mounts and stays until its closing is done", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame"] });
  const { container, rerender } = render(<Slot open={false} />);
  expect(container.querySelector(".workspace-band-slot")).toBeNull();

  rerender(<Slot open />);
  const slot = () => container.querySelector(".workspace-band-slot");
  // Mounted closed first, so the opening is seen.
  expect(slot()?.getAttribute("data-open")).toBe("false");
  act(() => {
    vi.advanceTimersByTime(20);
  });
  expect(slot()?.getAttribute("data-open")).toBe("true");

  rerender(<Slot open={false} />);
  expect(slot()?.getAttribute("data-open")).toBe("false");
  expect(screen.queryByText("Read-only")).not.toBeNull();
  act(() => {
    vi.advanceTimersByTime(440);
  });
  expect(slot()).toBeNull();
});

it("the band's 40px is held inside the Expand body, so the height has room to animate", () => {
  // Even with no band content (the condition has cleared) the reserve stays.
  const { container } = render(<BandSlot open>{null}</BandSlot>);
  const reserve = container.querySelector(
    ".ui-expand-body > .workspace-band-reserve",
  );
  expect(reserve).not.toBeNull();
  // The body must not carry the 40px itself: a min-height there starts the
  // 0fr to 1fr track at 40px and nothing is left to interpolate.
  expect(styles).not.toMatch(/\.workspace-band-slot[^{]*\.ui-expand-body/);
  expect(styles).toMatch(/\.workspace-band-reserve \{\s*min-height: 40px/);
});

it("a band that is there when the window opens is simply open", () => {
  const { container } = render(<Slot open />);
  expect(
    container.querySelector(".workspace-band-slot")?.getAttribute("data-open"),
  ).toBe("true");
});

it("under reduced motion the band is released at once", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame"] });
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
  const { container, rerender } = render(<Slot open />);
  rerender(<Slot open={false} />);
  act(() => {
    vi.advanceTimersByTime(0);
  });
  expect(container.querySelector(".workspace-band-slot")).toBeNull();
});

function Results({ query, items }: { query: string; items: string[] }) {
  const list = useRef<HTMLUListElement>(null);
  useResultCascade(list, query !== "");
  return (
    <ul ref={list}>
      {items.map((item) => (
        <li role="option" key={item} aria-selected={false}>
          {item}
        </li>
      ))}
    </ul>
  );
}

const cascade = () =>
  animate.mock.calls
    .map(([, options]) => options as KeyframeAnimationOptions)
    .filter((options) => String(options.easing).startsWith("cubic-bezier"))
    .map((options) => Math.round(options.delay ?? 0));

it("typing settles only the new results in, top first, a step apart", () => {
  const { rerender } = render(<Results query="" items={["a", "b"]} />);
  // The palette's opening is not typing.
  expect(animate).not.toHaveBeenCalled();
  rerender(<Results query="l" items={["a", "b", "c", "d", "e"]} />);
  // a and b were on show; c, d and e arrive.
  expect(cascade()).toEqual([0, 24, 48]);
  animate.mockClear();
  rerender(<Results query="lo" items={["a", "b", "c", "d", "e"]} />);
  expect(animate).not.toHaveBeenCalled();
});

it("a held key lands the results instantly", () => {
  const { rerender } = render(<Results query="" items={["a"]} />);
  document.documentElement.dataset.motion = "instant";
  restoreTokens();
  restoreTokens = applyTokens({
    ...rootTokens,
    "--dur-enter": "0ms",
    "--stagger": "0ms",
    "--spring-smooth-t": "0ms",
  });
  rerender(<Results query="l" items={["a", "b"]} />);
  expect(animate).not.toHaveBeenCalled();
  delete document.documentElement.dataset.motion;
});

it("the narrow navigation sheet glides in from its edge and slides back out", () => {
  const rule = (selector: string) =>
    new RegExp(
      `${selector.replace(/[[\]"=.]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    ).exec(styles)?.[1] ?? "";
  expect(rule('.ui-sheet[data-state="open"]')).toContain(
    "sheet-in var(--spring-smooth-t) var(--spring-smooth)",
  );
  expect(rule('.ui-sheet[data-state="closed"]')).toContain(
    "sheet-out var(--dur-exit) var(--ease-in)",
  );
  expect(styles).toContain("--sheet-from: -100%");
  expect(styles).toMatch(
    /@keyframes sheet-in\s*\{\s*from\s*\{\s*transform: translateX/,
  );
});

it("the collapsed sidebar fades its labels out and narrows on the smooth spring", () => {
  expect(styles).toMatch(
    /\.sidebar \{[^}]*transition:\s*width var\(--spring-smooth-t\) var\(--spring-smooth\)/,
  );
  expect(styles).toMatch(
    /\.sidebar\[data-collapsed\] :is\(\.sidebar-label[^{]*\{[^}]*opacity: 0;[^}]*var\(--dur-exit\)/,
  );
});

// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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

it("the sheet's scrim leaves with the sheet, never after it", () => {
  const closing = (selector: string) =>
    new RegExp(
      `${selector.replace(/[[\]"=.]/g, "\\$&")}\\s*\\{[^}]*animation:\\s*[\\w-]+ (var\\([^)]+\\))`,
    ).exec(styles)?.[1];
  expect(closing('[data-slot="sheet-overlay"][data-state="closed"]')).toBe(
    closing('.ui-sheet[data-state="closed"]'),
  );
  // Leftovers of the old overlay motion are gone.
  expect(styles).not.toContain("--sheet-scale");
  expect(styles).not.toContain("overlay-enter");
});

it("the collapsed sidebar fades its labels out and narrows on the smooth spring", () => {
  expect(styles).toMatch(
    /\.sidebar \{[^}]*transition:\s*width var\(--spring-smooth-t\) var\(--spring-smooth\)/,
  );
  expect(styles).toMatch(
    /\.sidebar\[data-collapsed\]\s+:is\(\.sidebar-label[^{]*\{[^}]*opacity: 0;[^}]*var\(--dur-exit\)/,
  );
});

it("the rail's footer buttons glide between the row and the column", () => {
  // Explicit places, so the pair and the column are one transition.
  expect(styles).toMatch(
    /\.sidebar-footer-actions > button \{[^}]*transition:[^;]*left var\(--spring-smooth-t\) var\(--spring-smooth\)/,
  );
  expect(styles).toMatch(
    /\.sidebar-footer-actions \{[^}]*transition: height var\(--spring-smooth-t\)/,
  );
  expect(styles).toMatch(
    /\.sidebar\[data-collapsed\] \.sidebar-footer-actions > button:last-child \{[^}]*top: var\(--header-control-height\)/,
  );
});

// Expanding the rail (DESIGN.md section 12): the width opens first, then the
// labels fade back in. The labels must be the same elements that faded out, or
// a fresh label mounts at full opacity beside the 56px rail.

function Rail({ open }: { open: boolean }) {
  return (
    <SidebarProvider open={open}>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="Inbox">
            <span className="sidebar-label">Inbox</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarProvider>
  );
}

it("folding and unfolding the rail keeps each row and its label in place", () => {
  const { rerender } = render(<Rail open />);
  const button = screen.getByRole("button", { name: "Inbox" });
  const label = screen.getByText("Inbox");
  rerender(<Rail open={false} />);
  expect(screen.getByRole("button", { name: "Inbox" })).toBe(button);
  expect(screen.getByText("Inbox")).toBe(label);
  rerender(<Rail open />);
  expect(screen.getByRole("button", { name: "Inbox" })).toBe(button);
  expect(screen.getByText("Inbox")).toBe(label);
});

it("the row's name is a label only on the folded rail, so Escape reaches the page", () => {
  let escapes = 0;
  render(
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape") escapes += 1;
      }}
    >
      <Rail open />
    </div>,
  );
  const button = screen.getByRole("button", { name: "Inbox" });
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => button.focus());
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(escapes).toBe(1);
});

const css = styles.replace(/\/\*[\s\S]*?\*\//g, "");

it("what the rail drops stays hidden until the width has opened", () => {
  // The width is the one clock: a label returns when the sidebar is wide,
  // however busy the main thread was while the width ran.
  expect(css).toMatch(/\.sidebar\s*\{[^}]*container-type:\s*inline-size/);
  const narrow = css.match(
    /@container sidebar \(max-width: (\d+)px\)\s*\{([\s\S]*?)\n\}/,
  );
  expect(narrow).not.toBeNull();
  const [, width, rules] = narrow ?? [];
  expect(Number(width)).toBeGreaterThan(56);
  expect(Number(width)).toBeLessThan(232);
  for (const part of [
    ".sidebar-label",
    ".sidebar-wordmark",
    ".sidebar-heading",
    ".sidebar-count",
    ".sidebar-jump kbd",
  ])
    expect(rules).toContain(part);
  expect(rules).toMatch(/\.sidebar:not\(\[data-collapsed\]\)/);
  expect(rules).toMatch(/opacity:\s*0/);
  // Hidden at once; the fade back starts as the rule stops matching.
  expect(rules).toMatch(/transition:\s*none/);
});

it("the unfold holds a count's words but never the dot the rail already shows", () => {
  const rules = css.match(
    /@container sidebar \(max-width: \d+px\)\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  // A bare .sidebar-count would hide the dot too, and it would blink.
  expect(rules).not.toMatch(/\.sidebar-count\s*[,)]/);
  expect(rules).toContain('.sidebar-count > :not([data-slot="status-dot"])');
  expect(rules).toContain('.sidebar-count:not(:has([data-slot="status-dot"]))');
});

it("a folding group's closing side fades out sooner than the Expand's own exit, so no sliver of its icon outlives the height", () => {
  const rule = css.match(
    /\.sidebar-group \.ui-expand\[data-open="false"\] > \.ui-expand-body\s*\{([^}]*)\}/,
  );
  expect(rule?.[1]).toMatch(/transition-duration:\s*var\(--dur-1\)/);
});

it("the labels fade back in with no delay of their own", () => {
  const rule = css.match(
    /\.sidebar-label,\s*\.sidebar-wordmark[^{]*\{([^}]*)\}/,
  );
  expect(rule?.[1]).toMatch(/transition:/);
  expect(rule?.[1]).not.toMatch(/var\(--dur-4\)/);
});

it("the two header buttons cross paths one after the other, never together", () => {
  const transition = (selector: RegExp) =>
    css.match(selector)?.[1]?.replace(/\s+/g, " ") ?? "";
  // Folding: New ticket drops at once, the collapse button slides over after it.
  expect(
    transition(
      /\.sidebar\[data-collapsed\] \.sidebar-top > button:not\(:last-child\)\s*\{\s*transition:([^}]*)\}/,
    ),
  ).toMatch(
    /right calc\(var\(--spring-smooth-t\) \* [\d.]+\) [^;]*calc\(var\(--spring-smooth-t\) \* 0\.\d+\)/,
  );
  expect(
    transition(
      /\.sidebar\[data-collapsed\] \.sidebar-top > button:last-child\s*\{\s*transition:([^}]*)\}/,
    ).trim(),
  ).toBe(
    "top var(--spring-smooth-t) var(--spring-smooth), right var(--spring-smooth-t) var(--spring-smooth);",
  );
  // Unfolding: the collapse button leaves the corner, New ticket climbs after.
  expect(
    transition(
      /\n\.sidebar-top > button:last-child\s*\{\s*transition:([^}]*)\}/,
    ),
  ).toMatch(
    /top calc\(var\(--spring-smooth-t\) \* [\d.]+\) [^;]*calc\(var\(--spring-smooth-t\) \* 0\.\d+\)/,
  );
});

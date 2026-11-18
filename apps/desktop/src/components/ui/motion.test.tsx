// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  Appear,
  Arrival,
  CrossfadeText,
  DrawnPath,
  Expand,
  Glide,
  MotionProvider,
  Presence,
  Shimmer,
} from "@/components/ui/motion";
import { frames, freezeMotionClock } from "@/test/motion-clock";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";

// The shared motion primitives (DESIGN.md section 12). Timing comes from the
// tokens, so these tests apply the real ones. Motion time is the test's own
// (test/motion-clock): it moves only when a test advances it, so nothing here
// depends on how fast the machine runs. A motion that is meant to be instant is
// done after the next frame without time moving at all; one that is not is
// still there until time has covered its duration.

// Longer than any entrance, spring included: time is ours, so it costs nothing.
const SETTLED_MS = 2000;
const EXIT_MS = 150;
const STAGGER_MS = 24;

let restoreTokens: () => void;
let clock: ReturnType<typeof freezeMotionClock>;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  clock = freezeMotionClock();
});
afterEach(() => {
  cleanup();
  clock.restore();
  restoreTokens();
});

function useReducedMotion() {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
}

function holdKey() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", repeat: true }),
    );
  });
}

function Shown({
  show,
  kind = "row",
  index = 0,
}: {
  show: boolean;
  kind?: "row" | "overlay";
  index?: number;
}) {
  return (
    <MotionProvider>
      <Presence>
        {show && (
          <Appear key="a" rise={kind} index={index}>
            Hello
          </Appear>
        )}
      </Presence>
    </MotionProvider>
  );
}

function Swapped({ text }: { text: string }) {
  return (
    <MotionProvider>
      <CrossfadeText>{text}</CrossfadeText>
    </MotionProvider>
  );
}

it("Appear starts soft and below its place, 6px for rows and 8px for overlays", () => {
  render(<Shown show kind="row" />);
  const row = screen.getByText("Hello");
  expect(row.style.opacity).toBe("0");
  expect(row.style.transform).toContain("translateY(6px)");
  expect(row.style.filter).toBe("blur(4px)");
  cleanup();
  render(<Shown show kind="overlay" />);
  expect(screen.getByText("Hello").style.transform).toContain(
    "translateY(8px)",
  );
});

it("Appear settles into place", async () => {
  render(<Shown show />);
  await frames();
  await clock.advance(SETTLED_MS);
  const { opacity, transform } = screen.getByText("Hello").style;
  expect([opacity, transform]).toEqual(["1", "none"]);
});

// Under the test clock the library never reaches its transitionEnd (the filter
// stays at blur(0px)), so this one runs in real time. It waits for a state, with
// no duration to compare against, so a slow machine only makes it take longer.
it("Appear carries no filter once settled, so long lists keep no compositing layers", async () => {
  clock.restore();
  render(<Shown show />);
  await waitFor(
    () => {
      const { opacity, filter } = screen.getByText("Hello").style;
      expect(opacity).toBe("1");
      expect(["", "none"]).toContain(filter);
    },
    { timeout: 10_000 },
  );
});

it("Appear carries no filter once settled under reduced motion", async () => {
  useReducedMotion();
  render(<Shown show />);
  await frames();
  const { opacity, filter } = screen.getByText("Hello").style;
  expect(opacity).toBe("1");
  expect(["", "none"]).toContain(filter);
});

it("Appear's stagger delays the whole entrance, not only the rise", async () => {
  render(<Shown show index={7} />);
  const row = screen.getByText("Hello");
  await frames(); // let the entrance start before time moves
  // Item 7 waits 7 steps. Just short of that, nothing has moved yet.
  await clock.advance(7 * STAGGER_MS - 10);
  expect(row.style.opacity).toBe("0");
  expect(row.style.filter).toBe("blur(4px)");
  expect(row.style.transform).toContain("translateY(6px)");
  // Well past the wait and the entrance, it has settled.
  await clock.advance(SETTLED_MS);
  expect(row.style.opacity).toBe("1");
  expect(row.style.transform).toBe("none");
});

it("Appear's stagger does not delay the first item", async () => {
  render(<Shown show index={0} />);
  await frames();
  await clock.advance(50);
  expect(Number(screen.getByText("Hello").style.opacity)).toBeGreaterThan(0);
});

it("Appear's stagger does not delay its exit", async () => {
  const { rerender } = render(<Shown show index={7} />);
  await frames();
  await clock.advance(SETTLED_MS);
  rerender(<Shown show={false} index={7} />);
  await frames();
  await clock.advance(EXIT_MS + 10);
  expect(screen.queryByText("Hello")).toBeNull();
});

it("Appear's stagger waits no longer under reduced motion", async () => {
  useReducedMotion();
  render(<Shown show index={7} />);
  await frames();
  expect(screen.getByText("Hello").style.opacity).toBe("1");
});

it("Appear's stagger waits no longer while a key repeats", async () => {
  const { rerender } = render(<Shown show={false} index={7} />);
  holdKey();
  rerender(<Shown show index={7} />);
  await frames();
  expect(screen.getByText("Hello").style.opacity).toBe("1");
});

it("Appear leaves in its own time, not at once", async () => {
  const { rerender } = render(<Shown show />);
  await frames();
  rerender(<Shown show={false} />);
  await frames();
  expect(screen.queryByText("Hello")).not.toBeNull();
  await clock.advance(EXIT_MS - 10);
  expect(screen.queryByText("Hello")).not.toBeNull();
  await clock.advance(20);
  expect(screen.queryByText("Hello")).toBeNull();
});

// The instant paths. Time stands still in these tests, so a leave that is gone
// after the next frame did not wait on any duration.
it("Appear leaves at once under reduced motion", async () => {
  useReducedMotion();
  const { rerender } = render(<Shown show />);
  rerender(<Shown show={false} />);
  await frames();
  expect(screen.queryByText("Hello")).toBeNull();
});

it("Appear leaves at once while a key repeats", async () => {
  const { rerender } = render(<Shown show />);
  holdKey();
  rerender(<Shown show={false} />);
  await frames();
  expect(screen.queryByText("Hello")).toBeNull();
});

it("the provider stops guarding when it unmounts", () => {
  const { unmount } = render(<MotionProvider>x</MotionProvider>);
  holdKey();
  expect(document.documentElement.dataset.motion).toBe("instant");
  unmount();
  expect(document.documentElement.dataset.motion).toBeUndefined();
});

it("Glide is one decorative highlight that follows the active item", () => {
  function Tabs({ active }: { active: "a" | "b" }) {
    return (
      <MotionProvider>
        {(["a", "b"] as const).map((id) => (
          <button key={id}>
            {id}
            {active === id && <Glide id="tabs" />}
          </button>
        ))}
      </MotionProvider>
    );
  }
  const { container, rerender } = render(<Tabs active="a" />);
  const highlight = () => container.querySelectorAll('[data-slot="glide"]');
  expect(highlight()).toHaveLength(1);
  expect(highlight()[0]?.getAttribute("aria-hidden")).toBe("true");
  expect(highlight()[0]?.parentElement?.textContent).toBe("a");
  rerender(<Tabs active="b" />);
  expect(highlight()).toHaveLength(1);
  expect(highlight()[0]?.parentElement?.textContent).toBe("b");
});

it("CrossfadeText shows the new text while the old one fades out", async () => {
  const { rerender } = render(<Swapped text="Open" />);
  rerender(<Swapped text="Closed" />);
  await frames();
  expect(screen.queryByText("Open")).not.toBeNull();
  expect(screen.queryByText("Closed")).not.toBeNull();
  await clock.advance(EXIT_MS - 10);
  expect(screen.queryByText("Open")).not.toBeNull();
  await clock.advance(20);
  expect(screen.queryByText("Open")).toBeNull();
  expect(screen.queryByText("Closed")).not.toBeNull();
});

it("CrossfadeText swaps at once under reduced motion", async () => {
  useReducedMotion();
  const { rerender } = render(<Swapped text="Open" />);
  rerender(<Swapped text="Closed" />);
  await frames();
  expect(screen.queryByText("Open")).toBeNull();
});

it("CrossfadeText swaps in one frame, never through a blank one, when motion is off", () => {
  for (const off of [useReducedMotion, holdKey]) {
    off();
    const { rerender, unmount } = render(<Swapped text="1" />);
    rerender(<Swapped text="2" />);
    // Straight after the commit: the old words gone, the new ones shown.
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.getByText("2").style.opacity).not.toBe("0");
    unmount();
  }
});

it("CrossfadeText swaps at once while a key repeats", async () => {
  const { rerender } = render(<Swapped text="Open" />);
  holdKey();
  rerender(<Swapped text="Closed" />);
  await frames();
  expect(screen.queryByText("Open")).toBeNull();
});

it("Expand keeps closed content mounted but inert", () => {
  const { container, rerender } = render(
    <Expand open={false}>
      <button>Inside</button>
    </Expand>,
  );
  const region = () => container.querySelector('[data-slot="expand"]');
  expect(screen.queryByText("Inside")).not.toBeNull();
  expect(region()?.hasAttribute("inert")).toBe(true);
  expect(region()?.getAttribute("data-open")).toBe("false");
  rerender(
    <Expand open>
      <button>Inside</button>
    </Expand>,
  );
  expect(region()?.hasAttribute("inert")).toBe(false);
  expect(region()?.getAttribute("data-open")).toBe("true");
});

it("Arrival plays again for each new arrival and not before", () => {
  const { container, rerender } = render(
    <div>
      <Arrival />
    </div>,
  );
  const flash = () => container.querySelector('[data-slot="arrival"]');
  expect(flash()).toBeNull();
  rerender(
    <div>
      <Arrival at={1} />
    </div>,
  );
  const first = flash();
  expect(first?.getAttribute("aria-hidden")).toBe("true");
  rerender(
    <div>
      <Arrival at={2} />
    </div>,
  );
  expect(flash()).not.toBe(first);
});

it("DrawnPath measures itself so its length is 1 whatever it draws", () => {
  const { container } = render(
    <svg>
      <DrawnPath d="M2 8l4 4 8-8" />
    </svg>,
  );
  const path = container.querySelector("path");
  expect(path?.getAttribute("pathLength")).toBe("1");
  expect(path?.getAttribute("d")).toBe("M2 8l4 4 8-8");
});

it("Shimmer keeps its words in the document", () => {
  render(<Shimmer>Working</Shimmer>);
  expect(screen.getByText("Working").getAttribute("data-slot")).toBe("shimmer");
});

// The pass is a light: its band reads lighter than the words, whichever theme
// and whichever text colour (jsdom paints nothing, so this reads the rule).
it("Shimmer's band is lighter than the text in both themes", () => {
  const css = readFileSync(join(__dirname, "motion.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const rule = css.match(/\.ui-shimmer\s*\{([^}]*)\}/)?.[1] ?? "";
  // Not a fixed grey: --disabled-foreground is #6b6b6b over #4d4d4d text in
  // light (barely lighter) and #8a8a8a under rgb(161,161,161) in dark (darker).
  expect(rule).not.toContain("--disabled-foreground");
  // The text's own colour mixed toward white is lighter than it by
  // construction, in any theme.
  const band = rule.match(/color-mix\(in srgb, currentcolor,? white (\d+)%\)/);
  expect(band).not.toBeNull();
  expect(Number(band?.[1])).toBeGreaterThanOrEqual(40);
});

// @vitest-environment jsdom
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
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";

// The shared motion primitives (DESIGN.md section 12). Timing comes from the
// tokens, so these tests apply the real ones. The motion library takes frames
// from the real requestAnimationFrame, so time here is real: a motion never
// finishes sooner than its duration, which is the bound these tests rely on.

const EXIT_MS = 150;

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
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

/** Milliseconds until the text has left the document. */
async function leaves(text: string): Promise<number> {
  const start = performance.now();
  await waitFor(() => expect(screen.queryByText(text)).toBeNull(), {
    interval: 4,
  });
  return performance.now() - start;
}

function Shown({
  show,
  kind = "row",
}: {
  show: boolean;
  kind?: "row" | "overlay";
}) {
  return (
    <MotionProvider>
      <Presence>
        {show && (
          <Appear key="a" rise={kind}>
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
  await waitFor(() => {
    const { opacity, transform } = screen.getByText("Hello").style;
    expect([opacity, transform]).toEqual(["1", "none"]);
  });
});

it("Appear carries no filter once settled, so long lists keep no compositing layers", async () => {
  render(<Shown show />);
  await waitFor(() => {
    const { opacity, filter } = screen.getByText("Hello").style;
    expect(opacity).toBe("1");
    expect(["", "none"]).toContain(filter);
  });
});

it("Appear carries no filter once settled under reduced motion", async () => {
  useReducedMotion();
  render(<Shown show />);
  await waitFor(() => {
    const { opacity, filter } = screen.getByText("Hello").style;
    expect(opacity).toBe("1");
    expect(["", "none"]).toContain(filter);
  });
});

it("Appear leaves in its own time, not at once", async () => {
  const { rerender } = render(<Shown show />);
  rerender(<Shown show={false} />);
  expect(screen.queryByText("Hello")).not.toBeNull();
  expect(await leaves("Hello")).toBeGreaterThanOrEqual(EXIT_MS - 10);
});

it("Appear leaves at once under reduced motion", async () => {
  useReducedMotion();
  const { rerender } = render(<Shown show />);
  rerender(<Shown show={false} />);
  expect(await leaves("Hello")).toBeLessThan(EXIT_MS - 10);
});

it("Appear leaves at once while a key repeats", async () => {
  const { rerender } = render(<Shown show />);
  holdKey();
  rerender(<Shown show={false} />);
  expect(await leaves("Hello")).toBeLessThan(EXIT_MS - 10);
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
  expect(screen.queryByText("Open")).not.toBeNull();
  expect(screen.queryByText("Closed")).not.toBeNull();
  expect(await leaves("Open")).toBeGreaterThanOrEqual(EXIT_MS - 10);
});

it("CrossfadeText swaps at once under reduced motion", async () => {
  useReducedMotion();
  const { rerender } = render(<Swapped text="Open" />);
  rerender(<Swapped text="Closed" />);
  expect(await leaves("Open")).toBeLessThan(EXIT_MS - 10);
});

it("CrossfadeText swaps at once while a key repeats", async () => {
  const { rerender } = render(<Swapped text="Open" />);
  holdKey();
  rerender(<Swapped text="Closed" />);
  expect(await leaves("Open")).toBeLessThan(EXIT_MS - 10);
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

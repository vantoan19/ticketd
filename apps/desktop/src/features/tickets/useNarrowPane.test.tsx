// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setPreference } from "@/lib/preferences";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { useNarrowPane } from "./useNarrowPane";

// The pane is narrow or not by its width. Only while the sidebar's width
// spring sweeps the content panel does the layout hold for the settled width;
// every other change of width is followed at once.

const SPRING_MS = 440;
const foldSidebar = () =>
  act(() => void setPreference("sidebarCollapsed", true));

let restoreTokens: () => void;

let resize: (width: number) => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  window.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resize = (width) =>
        callback(
          [{ contentRect: { width } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  setPreference("sidebarCollapsed", false);
  vi.useRealTimers();
  restoreTokens();
});

function Probe({ width }: { width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const narrow = useNarrowPane(ref, 880);
  return (
    <div
      ref={(node) => {
        ref.current = node;
        if (node) Object.defineProperty(node, "clientWidth", { value: width });
      }}
      data-narrow={narrow}
    />
  );
}

const narrow = (container: HTMLElement) =>
  container.firstElementChild?.getAttribute("data-narrow");

it("measures the first layout at once", () => {
  const { container } = render(<Probe width={700} />);
  expect(narrow(container)).toBe("true");
});

it("takes the observer's first report at once", () => {
  const { container } = render(<Probe width={0} />);
  act(() => resize(700));
  expect(narrow(container)).toBe("true");
});

it("does not flip while the sidebar's spring sweeps the width across the threshold", () => {
  const { container } = render(<Probe width={1000} />);
  expect(narrow(container)).toBe("false");
  act(() => resize(1000));
  foldSidebar();
  // A sidebar spring: the panel shrinks through 880 and ends narrow; the
  // flip waits for the width to stop changing.
  for (const width of [960, 900, 870, 850, 840]) {
    act(() => {
      resize(width);
      vi.advanceTimersByTime(16);
    });
    expect(narrow(container)).toBe("false");
  }
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(narrow(container)).toBe("true");
});

it("a sweep that ends on the same side never flips it", () => {
  const { container } = render(<Probe width={1000} />);
  act(() => resize(1000));
  foldSidebar();
  const flips: (string | null | undefined)[] = [];
  for (const width of [900, 860, 890, 940, 1000]) {
    act(() => {
      resize(width);
      vi.advanceTimersByTime(16);
    });
    flips.push(narrow(container));
  }
  act(() => {
    vi.advanceTimersByTime(300);
  });
  flips.push(narrow(container));
  expect(new Set(flips)).toEqual(new Set(["false"]));
});

it("follows a window edge being dragged across the threshold at once", () => {
  const { container } = render(<Probe width={1000} />);
  act(() => resize(1000));
  act(() => resize(900));
  expect(narrow(container)).toBe("false");
  act(() => resize(870));
  expect(narrow(container)).toBe("true");
  act(() => resize(890));
  expect(narrow(container)).toBe("false");
});

it("follows at once again once the sidebar's spring is over", () => {
  const { container } = render(<Probe width={1000} />);
  act(() => resize(1000));
  foldSidebar();
  act(() => void vi.advanceTimersByTime(SPRING_MS));
  act(() => resize(860));
  expect(narrow(container)).toBe("true");
});

it("takes the first report after the pane was hidden at once, even mid-spring", () => {
  const { container } = render(<Probe width={1000} />);
  act(() => resize(1000));
  // Hidden (display: none) it reports 0 and keeps its layout.
  act(() => resize(0));
  expect(narrow(container)).toBe("false");
  foldSidebar();
  act(() => resize(700));
  expect(narrow(container)).toBe("true");
});

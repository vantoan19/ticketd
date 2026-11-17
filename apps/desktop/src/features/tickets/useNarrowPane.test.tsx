// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNarrowPane } from "./useNarrowPane";

// The pane is narrow or not by its settled width: while a panel is resizing
// (the sidebar's width spring sweeps the content panel) the layout holds.

let resize: (width: number) => void;
beforeEach(() => {
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
  vi.useRealTimers();
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

it("does not flip while the width sweeps across the threshold", () => {
  const { container } = render(<Probe width={1000} />);
  expect(narrow(container)).toBe("false");
  act(() => resize(1000));
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

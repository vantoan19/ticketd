// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useReopened } from "./use-reopened";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let report: (shown: boolean) => void = () => {};
class FakeObserver {
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    report = (shown) => callback([{ isIntersecting: shown }]);
  }
  observe() {}
  disconnect() {}
}

function Page() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="page">
      {useReopened(ref)}
    </div>
  );
}
const count = () => screen.getByTestId("page").textContent;

test("counts each return to view, not the first sight", () => {
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  render(<Page />);
  act(() => report(true));
  expect(count()).toBe("0");
  act(() => report(false));
  act(() => report(true));
  expect(count()).toBe("1");
  act(() => report(false));
  act(() => report(true));
  expect(count()).toBe("2");
});

test("a page that started hidden counts its first opening", () => {
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  render(<Page />);
  act(() => report(false));
  act(() => report(true));
  expect(count()).toBe("1");
});

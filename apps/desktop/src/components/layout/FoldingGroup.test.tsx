// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { FoldingGroup } from "./FoldingGroup";

// A sidebar group that folds into one icon (DESIGN.md section 12): the list
// closes and the icon opens on the same spring, so what is below glides.

let restoreTokens: () => void;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
  vi.useRealTimers();
});

function Group({ collapsed }: { collapsed: boolean }) {
  return (
    <FoldingGroup collapsed={collapsed} rail={<p>rail</p>}>
      <p>list</p>
    </FoldingGroup>
  );
}

const expand = (text: string) =>
  [...document.querySelectorAll('[data-slot="expand"]')].find((node) =>
    node.textContent?.includes(text),
  );
const settle = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

it("shows only the list when the sidebar is open, with no motion on first render", () => {
  render(<Group collapsed={false} />);
  expect(expand("list")?.getAttribute("data-open")).toBe("true");
  expect(expand("rail")).toBeUndefined();
});

it("folding opens the icon and closes the list, which leaves once the spring is done", () => {
  const { rerender } = render(<Group collapsed={false} />);
  rerender(<Group collapsed />);
  // The icon mounts closed, then opens a frame later; the list closes at once.
  expect(expand("rail")?.getAttribute("data-open")).toBe("false");
  expect(expand("list")?.getAttribute("data-open")).toBe("false");
  settle(20);
  expect(expand("rail")?.getAttribute("data-open")).toBe("true");
  expect(expand("list")).toBeDefined();
  settle(440);
  expect(expand("list")).toBeUndefined();
});

it("unfolding does the same in reverse", () => {
  const { rerender } = render(<Group collapsed />);
  rerender(<Group collapsed={false} />);
  settle(20);
  expect(expand("list")?.getAttribute("data-open")).toBe("true");
  expect(expand("rail")?.getAttribute("data-open")).toBe("false");
  settle(440);
  expect(expand("rail")).toBeUndefined();
});

it("both sides carry the fold class the stylesheet's quick fade keys on", () => {
  const { rerender } = render(<Group collapsed={false} />);
  rerender(<Group collapsed />);
  expect(expand("list")?.classList.contains("sidebar-fold")).toBe(true);
  expect(expand("rail")?.classList.contains("sidebar-fold")).toBe(true);
});

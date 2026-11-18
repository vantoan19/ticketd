// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Viewport } from "@xyflow/react";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { ContextGraphCanvas } from "./ContextGraphCanvas";

// The view glides to where the app sends it and arrives (DESIGN.md section 12,
// "Focusing"). This runs the real React Flow, because what cut the glide short
// is how React Flow and a controlled viewport meet: React Flow hands the
// viewport state back after each frame, finds it one render behind the glide
// and snaps the view to it. The canvas must leave `viewport` out while it glides.

window.DOMMatrixReadOnly = class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  // React Flow takes the size of its pane from the box; zero would make the
  // glide's own arithmetic NaN.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 600,
    width: 1000,
    height: 600,
    toJSON: () => ({}),
  });
  vi.stubGlobal(
    "Worker",
    class {
      postMessage = vi.fn();
      terminate = vi.fn();
    },
  );
});
afterEach(() => {
  cleanup();
  restoreTokens();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a card added out of view is panned to, and the view arrives at the readable zoom", async () => {
  const seen: Viewport[] = [];
  function Page({ far }: { far: boolean }) {
    const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
    return (
      <ContextGraphCanvas
        edges={[]}
        selected={null}
        positions={{
          a: { x: 0, y: 0 },
          ...(far && { b: { x: 4000, y: 0 } }),
        }}
        onPositions={vi.fn()}
        viewport={viewport}
        onViewport={(next) => {
          seen.push(next);
          setViewport(next);
        }}
        onSelect={vi.fn()}
        onError={vi.fn()}
        nodes={[
          { id: "a", label: "A" },
          ...(far ? [{ id: "b", label: "B" }] : []),
        ]}
      />
    );
  }
  const view = render(<Page far={false} />);
  // Let the canvas mount before something is added.
  await waitFor(() =>
    expect(view.container.querySelector(".react-flow")).not.toBeNull(),
  );
  seen.length = 0;
  view.rerender(<Page far />);

  // The new card is 4000px away: showing it with the first one needs more room
  // than the canvas has, so the view settles at the readable zoom, 0.6.
  await waitFor(() => expect(seen.at(-1)?.zoom).toBeCloseTo(0.6, 2), {
    timeout: 4000,
  });
});

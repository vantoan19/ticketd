// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";
import { BulkControls } from "./BulkControls";
import type { BulkEdit } from "./useBulkEdit";

// The bulk bar rises when the first ticket is selected and sinks when the last
// is cleared (DESIGN.md section 12). Timing comes from the real tokens.

const EXIT_MS = 150;

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
});

function Bar({ selection }: { selection: string[] }) {
  const bulk = {
    selection,
    pending: false,
    failure: null,
    notice: null,
    retry: vi.fn(),
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    toggle: vi.fn(),
    applyOrganization: vi.fn(),
  } as unknown as BulkEdit;
  return (
    <MotionProvider>
      <BulkControls
        bulk={bulk}
        visible={[]}
        total={0}
        matchingReferences={() => Promise.resolve([])}
        projects={[]}
        plans={[]}
      />
    </MotionProvider>
  );
}

const bar = () => document.querySelector<HTMLElement>(".bulk-bar");
const region = () => screen.queryByRole("region", { name: "Bulk edit" });

/** Milliseconds until the bar has left the document. */
async function sinks(): Promise<number> {
  const start = performance.now();
  await waitFor(() => expect(bar()).toBeNull(), { interval: 4 });
  return performance.now() - start;
}

test("the first selection raises the bar 12px from a soft blur", async () => {
  const { rerender } = render(<Bar selection={[]} />);
  expect(bar()).toBeNull();
  rerender(<Bar selection={["T-KQ1"]} />);
  const { opacity, transform, filter } = bar()!.style;
  expect(opacity).toBe("0");
  expect(transform).toContain("translateY(12px)");
  expect(filter).toBe("blur(4px)");
  await waitFor(() => expect(bar()!.style.opacity).toBe("1"));
});

test("clearing the selection sinks the bar before it goes", async () => {
  const { rerender } = render(<Bar selection={["T-KQ1", "T-KQ2"]} />);
  rerender(<Bar selection={[]} />);
  expect(bar()).not.toBeNull();
  expect(region()).not.toBeNull();
  expect(bar()!.textContent).toContain("2 selected");
  expect(await sinks()).toBeGreaterThanOrEqual(EXIT_MS - 10);
  await waitFor(() => expect(region()).toBeNull());
});

test("clearing the selection removes the bar at once under reduced motion", async () => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
  const { rerender } = render(<Bar selection={["T-KQ1"]} />);
  rerender(<Bar selection={[]} />);
  expect(await sinks()).toBeLessThan(EXIT_MS - 10);
});

test("clearing the selection removes the bar at once while a key repeats", async () => {
  const { rerender } = render(<Bar selection={["T-KQ1"]} />);
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", repeat: true }),
    );
  });
  rerender(<Bar selection={[]} />);
  expect(await sinks()).toBeLessThan(EXIT_MS - 10);
});

test("the count changes in place as the selection grows", async () => {
  const { rerender } = render(<Bar selection={["T-KQ1"]} />);
  rerender(<Bar selection={["T-KQ1", "T-KQ2"]} />);
  expect(screen.queryByText("2 selected")).not.toBeNull();
  await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());
});

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { TestReads } from "@/lib/workspace-reads/testing";
import { frames } from "@/test/motion-clock";
import {
  EXIT_MS,
  holdKey,
  motionTestbed,
  SETTLED_MS,
} from "@/test/motion-testbed";
import { BulkControls } from "./BulkControls";
import type { BulkEdit } from "./useBulkEdit";

// The bulk bar rises when the first ticket is selected and sinks when the last
// is cleared (DESIGN.md section 12). Timing comes from the real tokens and the
// clock is the test's own (test/motion-clock).

const testbed = motionTestbed();

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
    <TestReads>
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
    </TestReads>
  );
}

const bar = () => document.querySelector<HTMLElement>(".bulk-bar");
const region = () => screen.queryByRole("region", { name: "Bulk edit" });

test("the first selection raises the bar 12px from a soft blur", async () => {
  const { rerender } = render(<Bar selection={[]} />);
  expect(bar()).toBeNull();
  rerender(<Bar selection={["T-KQ1"]} />);
  const { opacity, transform, filter } = bar()!.style;
  expect(opacity).toBe("0");
  expect(transform).toContain("translateY(12px)");
  expect(filter).toBe("blur(4px)");
  await frames();
  await testbed.advance(SETTLED_MS);
  expect(bar()!.style.opacity).toBe("1");
});

test("clearing the selection sinks the bar before it goes", async () => {
  const { rerender } = render(<Bar selection={["T-KQ1", "T-KQ2"]} />);
  rerender(<Bar selection={[]} />);
  await frames();
  expect(bar()).not.toBeNull();
  expect(region()).not.toBeNull();
  expect(bar()!.textContent).toContain("2 selected");
  await testbed.advance(EXIT_MS - 10);
  expect(bar()).not.toBeNull();
  await testbed.advance(SETTLED_MS);
  expect(bar()).toBeNull();
  expect(region()).toBeNull();
});

test("clearing the selection removes the bar at once under reduced motion", async () => {
  testbed.reduceMotion();
  const { rerender } = render(<Bar selection={["T-KQ1"]} />);
  rerender(<Bar selection={[]} />);
  await frames();
  expect(bar()).toBeNull();
});

test("clearing the selection removes the bar at once while a key repeats", async () => {
  const { rerender } = render(<Bar selection={["T-KQ1"]} />);
  holdKey();
  rerender(<Bar selection={[]} />);
  await frames();
  expect(bar()).toBeNull();
});

test("the count changes in place as the selection grows", async () => {
  const { rerender } = render(<Bar selection={["T-KQ1"]} />);
  rerender(<Bar selection={["T-KQ1", "T-KQ2"]} />);
  expect(screen.queryByText("2 selected")).not.toBeNull();
  await frames();
  await testbed.advance(SETTLED_MS);
  expect(screen.queryByText("1 selected")).toBeNull();
});

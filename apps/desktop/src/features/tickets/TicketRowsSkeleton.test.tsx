// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";
import { TicketRowsSkeleton } from "./TicketRowsSkeleton";

// Loading (DESIGN.md section 12): nothing for 300ms, so a fast read never
// flashes placeholders; then the rows fade up from a soft blur, a short step
// apart. Time is real: the motion library takes frames from requestAnimationFrame.

const LOADING_DELAY_MS = 300;

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
});

const rows = () => [
  ...document.querySelectorAll<HTMLElement>("ul.ticket-rows > li"),
];

function renderRows() {
  render(
    <MotionProvider>
      <TicketRowsSkeleton count={3} />
    </MotionProvider>,
  );
}

it("rows wait out the loading delay, then fade up from a blur one after another", async () => {
  const start = performance.now();
  renderRows();
  const [first, , last] = rows();
  expect(first?.style.opacity).toBe("0");
  expect(first?.style.transform).toContain("translateY(6px)");
  expect(first?.style.filter).toBe("blur(4px)");
  await waitFor(() => expect(first?.style.opacity).toBe("1"));
  expect(performance.now() - start).toBeGreaterThanOrEqual(
    LOADING_DELAY_MS - 10,
  );
  // The last row starts a stagger step per row behind the first.
  await waitFor(() => expect(last?.style.opacity).toBe("1"));
});

it("a fast read shows nothing before the delay", async () => {
  renderRows();
  await new Promise((resolve) => setTimeout(resolve, LOADING_DELAY_MS / 2));
  expect(rows().map((row) => row.style.opacity)).toEqual(["0", "0", "0"]);
});

it("rows are in place at once under reduced motion", async () => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
  const start = performance.now();
  renderRows();
  await waitFor(() => expect(rows()[0]?.style.opacity).toBe("1"));
  expect(performance.now() - start).toBeLessThan(LOADING_DELAY_MS - 10);
});

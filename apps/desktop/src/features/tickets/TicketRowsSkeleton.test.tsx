// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { frames } from "@/test/motion-clock";
import { motionTestbed, SETTLED_MS } from "@/test/motion-testbed";
import { TicketRowsSkeleton } from "./TicketRowsSkeleton";

// Loading (DESIGN.md section 12): nothing for 300ms, so a fast read never
// flashes placeholders; then the rows fade up from a soft blur, a short step
// apart. Time is the test's own (test/motion-clock).

const LOADING_DELAY_MS = 300;
const STAGGER_MS = 24;
const testbed = motionTestbed();

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

it("rows start soft and below their place", () => {
  renderRows();
  const [first] = rows();
  expect(first?.style.opacity).toBe("0");
  expect(first?.style.transform).toContain("translateY(6px)");
  expect(first?.style.filter).toBe("blur(4px)");
});

it("a fast read shows nothing before the delay", async () => {
  renderRows();
  await frames();
  await testbed.advance(LOADING_DELAY_MS - 10);
  expect(rows().map((row) => row.style.opacity)).toEqual(["0", "0", "0"]);
});

it("the rows then fade up one after another", async () => {
  renderRows();
  await frames();
  // Past the delay the first has started; the last waits two more steps.
  await testbed.advance(LOADING_DELAY_MS + STAGGER_MS);
  const [first, , last] = rows();
  expect(Number(first?.style.opacity)).toBeGreaterThan(0);
  expect(last?.style.opacity).toBe("0");
  await testbed.advance(SETTLED_MS);
  expect(rows().map((row) => row.style.opacity)).toEqual(["1", "1", "1"]);
});

it("rows are in place at once under reduced motion", async () => {
  testbed.reduceMotion();
  renderRows();
  await frames();
  expect(rows().map((row) => row.style.opacity)).toEqual(["1", "1", "1"]);
});

it("placeholders are not page rows: none is marked for a page arrival", () => {
  renderRows();
  expect(rows().some((row) => row.hasAttribute("data-arrive"))).toBe(false);
});

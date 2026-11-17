// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { m } from "motion/react";
import { expect, it } from "vitest";
import { MotionProvider, Presence } from "@/components/ui/motion";
import { arrival, departure, glide, pageArriving } from "./row-motion";
import { frames } from "@/test/motion-clock";
import {
  EXIT_MS,
  holdKey,
  motionTestbed,
  SETTLED_MS,
} from "@/test/motion-testbed";

// The one row motion for a list item (DESIGN.md section 12). Every list's rows
// are built from it, so this is where the stagger, the space and the resting
// style are pinned. Time is the test's own (test/motion-clock).

const STAGGER_MS = 24;
const testbed = motionTestbed();

type Shape = Parameters<typeof arrival>[1];

function Row({
  show = true,
  index = 0,
  shape,
}: {
  show?: boolean;
  index?: number;
  shape?: Shape;
}) {
  return (
    <MotionProvider>
      <ul>
        <Presence>
          {show && (
            <m.li
              key="row"
              {...arrival(index, shape)}
              {...departure({ space: shape?.space ?? false })}
            >
              Row
            </m.li>
          )}
        </Presence>
      </ul>
    </MotionProvider>
  );
}

const row = () => screen.getByText("Row");

it("starts soft and below its place, with no height of its own", () => {
  render(<Row />);
  const { opacity, transform, filter, height } = row().style;
  expect(opacity).toBe("0");
  expect(transform).toContain("translateY(6px)");
  expect(filter).toBe("blur(4px)");
  expect(height).toBe("");
});

it("waits `index` stagger steps before anything moves, in every property", async () => {
  render(<Row index={7} />);
  await frames();
  await testbed.advance(7 * STAGGER_MS - 10);
  expect(row().style.opacity).toBe("0");
  expect(row().style.filter).toBe("blur(4px)");
  expect(row().style.transform).toContain("translateY(6px)");
  await testbed.advance(SETTLED_MS);
  expect(row().style.opacity).toBe("1");
  expect(row().style.transform).toBe("none");
});

it("waits no longer than eight steps, however far down the list", async () => {
  render(<Row index={40} />);
  await frames();
  await testbed.advance(7 * STAGGER_MS + 40);
  expect(Number(row().style.opacity)).toBeGreaterThan(0);
});

it("does not delay the first row", async () => {
  render(<Row index={0} />);
  await frames();
  await testbed.advance(50);
  expect(Number(row().style.opacity)).toBeGreaterThan(0);
});

it("a row that opens its space starts with no height and a closed margin", () => {
  render(<Row shape={{ space: true, gap: 6 }} />);
  const { height, marginTop, overflow } = row().style;
  expect([height, marginTop, overflow]).toEqual(["0px", "0px", "clip"]);
});

it("the space opens after the stagger, as the rest of the entrance does", async () => {
  render(<Row index={7} shape={{ space: true }} />);
  await frames();
  await testbed.advance(7 * STAGGER_MS - 10);
  expect(row().style.height).toBe("0px");
  await testbed.advance(SETTLED_MS);
  expect(row().style.height).not.toBe("0px");
});

it("waits `after` seconds first, the loading delay", async () => {
  render(<Row shape={{ after: 0.3 }} />);
  await frames();
  await testbed.advance(290);
  expect(row().style.opacity).toBe("0");
  await testbed.advance(SETTLED_MS);
  expect(row().style.opacity).toBe("1");
});

// The library never reaches its transitionEnd under the test clock, so the
// resting style is read in real time, by state and not by duration.
it("carries no filter once settled, and stops clipping, so long lists keep no compositing layers", async () => {
  testbed.realTime();
  render(<Row shape={{ space: true }} />);
  await waitFor(
    () => {
      const { opacity, filter, overflow } = row().style;
      expect(opacity).toBe("1");
      expect(["", "none"]).toContain(filter);
      expect(overflow).toBe("visible");
    },
    { timeout: 10_000 },
  );
});

it("leaves in its own time, and its stagger does not delay the exit", async () => {
  const { rerender } = render(<Row index={7} />);
  await frames();
  await testbed.advance(SETTLED_MS);
  rerender(<Row index={7} show={false} />);
  await frames();
  expect(screen.queryByText("Row")).not.toBeNull();
  await testbed.advance(EXIT_MS - 10);
  expect(screen.queryByText("Row")).not.toBeNull();
  await testbed.advance(20);
  expect(screen.queryByText("Row")).toBeNull();
});

it("leaves at once under reduced motion", async () => {
  testbed.reduceMotion();
  const { rerender } = render(<Row />);
  rerender(<Row show={false} />);
  await frames();
  expect(screen.queryByText("Row")).toBeNull();
});

it("leaves at once while a key repeats", async () => {
  const { rerender } = render(<Row />);
  await frames();
  holdKey();
  rerender(<Row show={false} />);
  await frames();
  expect(screen.queryByText("Row")).toBeNull();
});

it("a glide is measured only when its dependency changes", () => {
  expect(glide("a,b").layoutDependency).toBe("a,b");
  expect(glide().layout).toBe("position");
});

it("a glide takes the spring it is asked for", () => {
  const smooth = glide().transition.layout.duration;
  const travel = glide(undefined, "travel").transition.layout.duration;
  expect(smooth).toBeGreaterThan(0);
  expect(travel).toBeGreaterThan(smooth);
});

it("a page arrival is any marked element but a row's own fill marker", () => {
  expect(pageArriving()).toBe(false);
  const li = document.body.appendChild(document.createElement("li"));
  li.dataset.arriving = "true";
  expect(pageArriving()).toBe(false);
  const page = document.body.appendChild(document.createElement("div"));
  page.dataset.arriving = "";
  expect(pageArriving()).toBe(true);
  li.remove();
  page.remove();
});
